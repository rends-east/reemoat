#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_IDS, AGENT_LOGIN, MANAGED_CLI_DIRS } from "../src/acp/agents.js";
// Imported so the emitter in agents.sh is driven against the real parser.
import { readStep } from "../src/agentinstall.js";
import { SETTING_KEYS, envNameFor } from "../packages/control-plane/src/settings.js";
import { tmp } from "./tmp.js";

/** Regression driver for deploy/: every case runs in a sandbox home, so rendering a unit never touches the real one. */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(
    `  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`,
  );
}

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const deployDir = join(repoRoot, "deploy");

// The home path holds &, < and |, so one fixture drives the whole esc_sed/esc_xml/render_unit escaping chain.
const sandbox = realpathSync(tmp("deploycheck-"));
const home = join(sandbox, "home a&b<c|d");
mkdirSync(join(home, ".reemoat"), { recursive: true });

// Built from nothing, so the developer's own REEMOAT_* variables cannot decide what this measures.
const baseEnv: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  REEMOAT_CPCTL_ENV: join(home, ".reemoat", "cpctl.env"),
};

interface Run {
  status: number;
  out: string;
  err: string;
}

/** One `sh` with `lib.sh` already sourced, in the only directory it resolves from. */
function sh(script: string, env: Record<string, string> = {}): Run {
  const result = spawnSync("sh", ["-c", `. ./lib.sh\n${script}`], {
    cwd: deployDir,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });
  return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
}

// Compared against itself at the end rather than a clean tree, so uncommitted edits to deploy/ do not fail the run.
function deployState(): string {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "deploy"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

const deployBefore = deployState();

process.stdout.write("\nwhere lib.sh thinks it is\n");

check("DEPLOY_DIR is the directory holding it", sh('printf "%s" "$DEPLOY_DIR"').out, deployDir);
check("and REPO_ROOT is its parent", sh('printf "%s" "$REPO_ROOT"').out, repoRoot);

process.stdout.write("\nquoting a value into a file that gets sourced\n");

const hostile: Array<[string, string]> = [
  ["a command substitution", "xy$(touch PWNED)"],
  ["a backquote", "xy`touch PWNED`"],
  ["an ampersand", "a&b"],
  ["a semicolon", "a;b"],
  ["a space", "a b"],
  ["a backslash", "a\\b"],
  ["a double quote", 'a"b'],
  ["a single quote", "it's"],
  ["a variable reference", "$HOME and ${HOME}"],
  ["an interior newline", "line1\nline2"],
  ["a trailing newline", "a\n"],
  ["nothing but newlines", "\n\n"],
  ["a pipe into another command", "a | touch PWNED"],
  ["everything at once", "$(touch PWNED); `touch PWNED` & 'x' \"y\" \\z |"],
];

for (const [name, raw] of hostile) {
  const run = sh(
    [
      'f="$SANDBOX/roundtrip.env"',
      ': > "$f"',
      'printf "K=%s\\n" "$(sq "$RAW")" >> "$f"',
      '. "$f"',
      '[ "$K" = "$RAW" ] && printf same || printf "DIFFERENT: [%s]" "$K"',
    ].join("\n"),
    { RAW: raw, SANDBOX: sandbox },
  );
  check(`${name} survives the round trip`, run.out, "same");
}

check("and nothing in it ever ran", existsSync(join(deployDir, "PWNED")), false);

{
  const run = sh(
    [
      'f="$SANDBOX/unquoted.env"',
      'printf "K=%s\\n" "$RAW" > "$f"',
      '. "$f"',
      'printf "%s" "$K"',
    ].join("\n"),
    { RAW: "xy$(touch $SANDBOX/UNQUOTED)", SANDBOX: sandbox },
  );
  check("an unquoted value really does execute on source", run.out, "xy");
  check("and leaves the file behind, which is what sq prevents", existsSync(join(sandbox, "UNQUOTED")), true);
}

process.stdout.write("\nwriting a value into an environment file\n");

const envFile = join(sandbox, "daemon.env");
const cpEnvFile = join(sandbox, "control-plane.env");

{
  writeFileSync(envFile, "REEMOAT_PORT=7887\nREEMOAT_PORT_EXTRA=keep\n");
  const appended = sh('set_env REEMOAT_HOST "127.0.0.1" "$F"; printf "%s" "$(file_value "$F" REEMOAT_HOST)"', {
    F: envFile,
  });
  check("a new key is appended and reads back", appended.out, "127.0.0.1");
  check("and the file ends up 0600, whatever the umask was", statSync(envFile).mode & 0o777, 0o600);

  const replaced = sh('set_env REEMOAT_HOST "0.0.0.0" "$F"; printf "%s" "$(file_value "$F" REEMOAT_HOST)"', {
    F: envFile,
  });
  check("replacing a key reads back the new value", replaced.out, "0.0.0.0");
  check("and the replace arm agrees with the append arm about the mode", statSync(envFile).mode & 0o777, 0o600);

  const lines = readFileSync(envFile, "utf8").split("\n").filter((line) => line.startsWith("REEMOAT_HOST="));
  check("replacing writes one line, not two", lines.length, 1);
}

{
  writeFileSync(envFile, "REEMOAT_TOKEN=old\n");
  sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\\nINJECTED=yes" });
  const body = readFileSync(envFile, "utf8");
  check("a literal backslash-n injects no second assignment", /^INJECTED=/m.test(body), false);
  check("and the value keeps both characters", sh('printf "%s" "$(file_value "$F" REEMOAT_TOKEN)"', { F: envFile }).out, "a\\nINJECTED=yes");
}

{
  writeFileSync(envFile, "REEMOAT_PORT=7887\nREEMOAT_PORT_EXTRA=keep\n");
  sh('set_env REEMOAT_PORT "9999" "$F"', { F: envFile });
  check("a longer key sharing the prefix is untouched", sh('printf "%s" "$(file_value "$F" REEMOAT_PORT_EXTRA)"', { F: envFile }).out, "keep");
  check("while the key that was named did change", sh('printf "%s" "$(file_value "$F" REEMOAT_PORT)"', { F: envFile }).out, "9999");
}

{
  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  const refused = sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: cpEnvFile, V: "it's" });
  check("an apostrophe into the control plane's file is refused", refused.status, 2);
  check("and says which parser cannot read it", /docker compose|dotenv/.test(refused.err), true);
  check("leaving the file alone", readFileSync(cpEnvFile, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");

  writeFileSync(envFile, "REEMOAT_TOKEN=x\n");
  const allowed = sh('set_env REEMOAT_NAME "$V" "$F"; printf "%s" "$(file_value "$F" REEMOAT_NAME)"', {
    F: envFile,
    V: "it's",
  });
  check("but the daemon's file, which only sh reads, takes one", allowed.out, "it's");

  const partial = `${cpEnvFile}.partial`;
  writeFileSync(partial, "REEMOAT_CP_HOST=127.0.0.1\n");
  const refusedPartial = sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: partial, V: "it's" });
  check("an apostrophe into the file the interview actually writes is refused too", refusedPartial.status, 2);
  check("and that file is left alone as well", readFileSync(partial, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

{
  const overrideCp = join(sandbox, "cp.env");
  const overrides = { REEMOAT_CP_ENV_FILE: overrideCp };

  writeFileSync(overrideCp, "REEMOAT_CP_HOST=127.0.0.1\n");
  const refused = sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: overrideCp, V: "o'brien" });
  check("an apostrophe into the file REEMOAT_CP_ENV_FILE names is refused", refused.status, 2);
  check("naming the parser that cannot read it, as the suffix arms do", /docker compose|dotenv/.test(refused.err), true);
  check("with that file untouched", readFileSync(overrideCp, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");

  const overridePartial = `${overrideCp}.partial`;
  writeFileSync(overridePartial, "REEMOAT_CP_HOST=127.0.0.1\n");
  check(
    "and its .partial, which is what the interview actually writes",
    sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: overridePartial, V: "o'brien" }).status,
    2,
  );
  check("leaving that one alone too", readFileSync(overridePartial, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");

  const overrideDaemon = join(sandbox, "d.env");
  writeFileSync(overrideDaemon, "REEMOAT_TOKEN=x\n");
  check(
    "while the daemon's file, wherever it has been moved to, still takes one",
    sh('set_env REEMOAT_NAME "$V" "$F"; printf "%s" "$(file_value "$F" REEMOAT_NAME)"', {
      ...overrides,
      REEMOAT_ENV_FILE: overrideDaemon,
      F: overrideDaemon,
      V: "it's",
    }).out,
    "it's",
  );

  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  check(
    "and the name is still consulted while the override points elsewhere",
    sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: cpEnvFile, V: "it's" }).status,
    2,
  );
  check("with that file untouched as well", readFileSync(cpEnvFile, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

{
  const secret = (typed: string[]): { out: string; err: string } =>
    sh('printf "%s" "$IN" | ask_secret "password" 12', { IN: typed.map((line) => `${line}\n`).join("") });

  check(
    "a password typed twice is returned once",
    secret(["a-fine-long-password", "a-fine-long-password"]).out,
    "a-fine-long-password",
  );
  const mismatched = secret(["a-fine-long-password", "a-different-one", "a-fine-long-password", "a-fine-long-password"]);
  check("a mismatch re-asks rather than failing", mismatched.out, "a-fine-long-password");
  check("and says so", /do not match/.test(mismatched.err), true);
  const short = secret(["short", "short", "a-fine-long-password", "a-fine-long-password"]);
  check("too short re-asks", short.out, "a-fine-long-password");
  check("and names the minimum", /at least 12/.test(short.err), true);

  const quoted = secret(["it's-a-long-one", "it's-a-long-one", "a-fine-long-password", "a-fine-long-password"]);
  check("an apostrophe re-asks instead of ending the interview", quoted.out, "a-fine-long-password");
  check("and says why that character cannot be used", /dotenv|compose/.test(quoted.err), true);
  check("nothing is written to stdout but the value", secret(["a-fine-long-password", "a-fine-long-password"]).out.includes("password:"), false);

  const dangerous = "a$(touch PWNED)`touch PWNED`b";
  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  const roundTrip = sh(
    'set_env REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD "$V" "$F"; ' +
      'set -a; . "$F"; set +a; printf "%s" "$REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD"',
    { F: cpEnvFile, V: dangerous },
  );
  check("a password full of shell survives being written and sourced", roundTrip.out, dangerous);
  check("and none of it ran", existsSync(join(deployDir, "PWNED")), false);
}

{
  writeFileSync(envFile, "REEMOAT_TOKEN=old\n");
  const appended = sh('set_env REEMOAT_NEW "$V" "$F"', { F: envFile, V: "line1\nline2" });
  check("a newline is refused on the way in", appended.status, 2);
  check("naming the arm that cannot survive it", /physical line|orphans/.test(appended.err), true);
  check("and the file is untouched", readFileSync(envFile, "utf8"), "REEMOAT_TOKEN=old\n");

  const replaced = sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\nb" });
  check("and refused on the arm that would have orphaned it", replaced.status, 2);
  check("leaving that file alone too", readFileSync(envFile, "utf8"), "REEMOAT_TOKEN=old\n");

  check("a value that merely ends in one is refused as well", sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\n" }).status, 2);

  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  check("the control plane's file refuses one too", sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: cpEnvFile, V: "a\nb" }).status, 2);
  check("and a value carrying both faults is still refused", sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: cpEnvFile, V: "it's\nb" }).status, 2);
  check("with that file untouched", readFileSync(cpEnvFile, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

process.stdout.write("\nreading one value back out\n");

{
  const run = sh('file_value "$F" "A:-$(printf %s "\\$(touch $SANDBOX/EVALED)")"', { F: envFile, SANDBOX: sandbox });
  check("a key that is not a key is refused", run.status, 2);
  check("and the eval never ran", existsSync(join(sandbox, "EVALED")), false);
  check("an empty key is refused too", sh('file_value "$F" ""', { F: envFile }).status, 2);
}

// Asserted in the assignment form callers use: errexit never fires for a substitution in argument position.
{
  const missing = sh('V=$(file_value "$SANDBOX/nope.env" REEMOAT_TOKEN); printf "[%s]" "$V"', { SANDBOX: sandbox });
  check("a file that is not there is empty rather than fatal under set -e", missing.out, "[]");
  check("and the script carries on rather than dying at the assignment", missing.status, 0);
  check("with nothing on stderr to explain a failure that did not happen", missing.err, "");

  const absent = sh('V=$(file_value "$F" REEMOAT_NOT_SET); printf "[%s]" "$V"', { F: envFile });
  check("and so is a key the file does not hold", absent.out, "[]");
  check("also without failing the caller", absent.status, 0);
}

process.stdout.write("\nnaming a service\n");

check("daemon is one", sh("if valid_service daemon; then printf yes; else printf no; fi").out, "yes");
check("control-plane is one", sh("if valid_service control-plane; then printf yes; else printf no; fi").out, "yes");
check("relay is one", sh("if valid_service relay; then printf yes; else printf no; fi").out, "yes");
check("a typo is not", sh("if valid_service deamon; then printf yes; else printf no; fi").out, "no");

check("the daemon is supervised by a unit", sh("service_backend daemon").out, "unit");
check("and the control plane by a container", sh("service_backend control-plane").out, "docker");
check("and the relay by one of its own", sh("service_backend relay").out, "docker");

check(
  "each containerised service names its own compose service",
  [sh("compose_service control-plane").out, sh("compose_service relay").out],
  ["control-plane", "relay"],
);
{
  const run = sh("compose_service daemon");
  check("and asking about one that is not containerised refuses", run.status, 2);
  check("with nothing on stdout to be pasted into a compose command", run.out, "");
}

check("the daemon's unit runs the wrapper", sh("service_exec daemon").out, join(deployDir, "run-daemon.sh"));
{
  const run = sh("service_exec control-plane");
  check("the control plane has no unit to run, and says so rather than printing nothing", run.status, 2);
  check("with nothing on stdout to be substituted into a template", run.out, "");
  check("and the remedy names the wrapper that does start it", run.err.includes("compose.sh up -d"), true);
}
{
  const run = sh("service_exec relay");
  check("the relay refuses the same way, rather than being the arm nobody added", run.status, 2);
  check("with nothing on stdout either", run.out, "");
  check("and its own remedy", run.err.includes("compose.sh up -d"), true);
}

check("launchd names a unit in reverse domain form", sh("INIT_SYSTEM=launchd; unit_label daemon").out, "com.reemoat.daemon");
check("and systemd hyphenates", sh("INIT_SYSTEM=systemd; unit_label daemon").out, "reemoat-daemon");

check(
  "only launchd writes log files",
  [sh("INIT_SYSTEM=launchd; log_dir").out, sh("INIT_SYSTEM=systemd; printf '[%s]' \"$(log_dir)\"").out],
  [join(home, "Library/Logs/reemoat"), "[]"],
);

check(
  "a unit lands where its supervisor looks",
  [sh("INIT_SYSTEM=launchd; unit_target daemon").out, sh("INIT_SYSTEM=systemd; unit_target daemon").out],
  [join(home, "Library/LaunchAgents/com.reemoat.daemon.plist"), join(home, ".config/systemd/user/reemoat-daemon.service")],
);

process.stdout.write("\nwhere an environment file comes from\n");

check("the daemon's default is under the state directory", sh("env_file daemon").out, join(home, ".reemoat/daemon.env"));
check("and the control plane's beside it", sh("env_file control-plane").out, join(home, ".reemoat/control-plane.env"));
check("and the relay reads the control plane's own file", sh("env_file relay").out, sh("env_file control-plane").out);
check(
  "all three are overridable, because a packaged install will not want them under HOME",
  [
    sh("env_file daemon", { REEMOAT_ENV_FILE: "/etc/reemoat/d.env" }).out,
    sh("env_file control-plane", { REEMOAT_CP_ENV_FILE: "/etc/reemoat/cp.env" }).out,
    sh("env_file relay", { REEMOAT_CP_ENV_FILE: "/etc/reemoat/cp.env" }).out,
  ],
  ["/etc/reemoat/d.env", "/etc/reemoat/cp.env", "/etc/reemoat/cp.env"],
);
check(
  "and each example mirrors where it lives in the repository",
  [sh("env_example daemon").out, sh("env_example control-plane").out, sh("env_example relay").out],
  [
    join(repoRoot, ".env.example"),
    join(repoRoot, "packages/control-plane/.env.example"),
    join(repoRoot, "packages/control-plane/.env.example"),
  ],
);

/** A literal on purpose: keyed on AGENT_IDS, so a new agent fails to compile until its npm package is named (Q4.114). */
const NPM_PACKAGES: Record<(typeof AGENT_IDS)[number], string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
  kimi: "@moonshot-ai/kimi-code",
  grok: "@xai-official/grok",
};

{
  const daemonExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const named = AGENT_IDS.map((id) => AGENT_LOGIN[id].executableEnv).filter((one): one is string => one !== null);

  check("every harness that has a binary override is documented", named.filter((key) => !daemonExample.includes(key)), []);
  check(
    "each shown as a commented assignment rather than only mentioned in prose",
    named.filter((key) => !new RegExp(`^#\\s*${key}=`, "m").test(daemonExample)),
    [],
  );
  check("and the credential directory is named as not being one of them", /CODEX_HOME/.test(daemonExample), true);

  check("the state root is documented", /^#\s*REEMOAT_HOME=/m.test(daemonExample), true);
  const homeBlock = daemonExample.split(/\n\s*\n/).find((para) => /^#\s*REEMOAT_HOME=/m.test(para)) ?? "";
  check("and as one to leave unset in a file a service sources", /leave it unset/i.test(homeBlock), true);

  const cpExample = readFileSync(join(repoRoot, "packages", "control-plane", ".env.example"), "utf8");
  check(
    "every runtime setting is documented as a commented assignment",
    SETTING_KEYS.filter((key) => !new RegExp(`^#\\s*${envNameFor(key)}=`, "m").test(cpExample)),
    [],
  );
  const sourceBlock = daemonExample.split(/\n\s*\n/).find((para) => /^#\s*REEMOAT_AGENT_SOURCE=/m.test(para)) ?? "";
  check(
    "and where the CLIs come from is shown as a commented assignment, at its default",
    /^#\s*REEMOAT_AGENT_SOURCE=vendor$/m.test(daemonExample),
    true,
  );
  check("with npm named as the other value", /`npm`/.test(sourceBlock), true);
  check(
    "and the four packages that value installs, for whoever has to mirror them",
    AGENT_IDS.filter((id) => !sourceBlock.includes(NPM_PACKAGES[id])),
    [],
  );
  check("and the installer flag that writes it", sourceBlock.includes("--agent-source npm"), true);
  const channelBlock = daemonExample.split(/\n\s*\n/).find((para) => /^#\s*REEMOAT_AGENT_CHANNEL=/m.test(para)) ?? "";
  check("which of claude's channels it follows is shown the same way, at its default", /^#\s*REEMOAT_AGENT_CHANNEL=latest$/m.test(daemonExample), true);
  check(
    "naming both values, the day it was measured, and whose installer reads it",
    [/`stable`/.test(channelBlock), /`latest`/.test(channelBlock), channelBlock.includes("2026-09-05"), channelBlock.includes("claude's vendor installer only")],
    [true, true, true, true],
  );
  check("that a change moves the machine either way and keeps the old build", [channelBlock.includes("down as well as up"), channelBlock.includes("keeping the old build on disk")], [true, true]);
  check("and the installer flag that writes this one", channelBlock.includes("--agent-channel stable"), true);
}

{
  const agentsRaw = readFileSync(join(repoRoot, "deploy/agents.sh"), "utf8");
  // Negative assertions read only non-comment lines, so agents.sh's prose may name what its code must not do.
  const agentLines = agentsRaw.split("\n").filter((line) => !/^\s*#/.test(line));
  const agents = agentLines.join("\n");
  check("the agent installer was found", agentsRaw.length > 0, true);
  check("and it is executable, because every caller execs it directly", (statSync(join(repoRoot, "deploy/agents.sh")).mode & 0o111) !== 0, true);
  check("and its reasoning is written down rather than left to a reader", agentsRaw.length > agents.length, true);

  check("it never reaches for root", /\bsudo\b/.test(agents), false);

  check("and never calls kimi's own upgrade, which lies about having run", /kimi\s+(upgrade|update)/.test(agents), false);

  const home = process.env["HOME"] ?? "";
  const named = MANAGED_CLI_DIRS.map((dir) => dir.replace(home, "$HOME_DIR"));
  check(
    "every directory the daemon searches is one this script installs into",
    named.filter((dir) => !agents.includes(dir)),
    [],
  );

  check("each agent has a refresh that does not re-download it", [
    /claude install "\$CHANNEL"/.test(agents),
    /codex update/.test(agents),
    /opencode upgrade --method curl/.test(agents),
    agents.includes(`ensure_npm kimi ${NPM_PACKAGES.kimi} `),
    /"\$_pkg@latest"/.test(agents),
  ], [true, true, true, true, true]);

  check("its directories are appended to PATH, never prepended", /^PATH="\$PATH:/m.test(agents), true);
  check("no installer is piped straight into a shell", /curl[^\n]*\|\s*(ba)?sh\b/.test(agents), false);
  check("and every download carries a deadline", /curl [^\n]*--max-time \d+/.test(agents), true);
  check("and refuses a redirect off https", /curl [^\n]*--proto '=https' --proto-redir '=https'[^\n]*--max-time/.test(agents), true);
  const pipeTrapAt = agentLines.findIndex((line) => line === "trap '' PIPE");
  const parserAt = agentLines.findIndex((line) => line.startsWith('for _arg in "$@"; do'));
  check("SIGPIPE is ignored before the first line that could print", [pipeTrapAt !== -1, pipeTrapAt < parserAt], [true, true]);
  check(
    "and say, note and warn each tolerate a closed stream, in a subshell",
    [
      lineIn("agents.sh", agentLines, "say", "say()"),
      lineIn("agents.sh", agentLines, "note", "note()"),
      lineIn("agents.sh", agentLines, "warn", "warn()"),
    ],
    [
      `say()  { ( printf '%s\\n' "$*" ) 2>/dev/null || :; }`,
      `note() { ( printf '  %s\\n' "$*" ) 2>/dev/null || :; }`,
      `warn() { ( printf '%s\\n' "$*" >&2 2>/dev/null ) || :; }`,
    ],
  );
  const finish = blockIn("agents.sh", agentLines, "finish", "finish() {", "}");
  check(
    "one EXIT trap releases the temporary directory and, only if held, the lock",
    [
      agentLines.filter((line) => /\btrap\b[^\n]*\bEXIT\b/.test(line)),
      finish.includes('rm -rf "$TMP"'),
      finish.includes('[ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK"'),
      lineIn("agents.sh", agentLines, "the lock path", "LOCK="),
    ],
    [["trap finish EXIT"], true, true, 'LOCK="$TOOLCHAIN/.agents.lock"'],
  );
  const takeLock = blockIn("agents.sh", agentLines, "take_lock", "take_lock() {", "}");
  const mainBody = blockIn("agents.sh", agentLines, "main", "main() {", "}");
  check(
    "the lock is taken first in main, never under --check, by mkdir, and a live owner is a sentence and exit 0",
    [
      mainBody.split("\n")[1]?.trim(),
      takeLock.split("\n")[1]?.trim(),
      /^\s*if mkdir "\$LOCK" 2>\/dev\/null; then$/m.test(takeLock),
      /kill -0 "\$_pid"/.test(takeLock),
      takeLock.includes('warn "another run of deploy/agents.sh (pid $_pid) is in progress; nothing was changed"'),
    ],
    ["take_lock", '[ "$CHECK" = 1 ] && return 0', true, true, true],
  );
  const overrides = AGENT_IDS.map((id) => AGENT_LOGIN[id].executableEnv).filter((one): one is string => one !== null);
  check(
    "a harness whose binary an operator named is left alone",
    overrides.filter((key) => !new RegExp(`\\$\\{${key}:-\\}`).test(agents)),
    [],
  );
  check("the three vendor installers are fetched from here", [
    /download claude https:\/\/claude\.ai\//.test(agents),
    /download codex https:\/\/chatgpt\.com\//.test(agents),
    /download opencode https:\/\/opencode\.ai\//.test(agents),
  ], [true, true, true]);

  check("an npm-installed harness lands in a directory of its own rather than over the one that runs", /\$_agent-\$_ver/.test(agents) && /mv -f .*bin\/\$_agent/.test(agents), true);
  check("staged under the toolchain, so the move is one rename", /npm" i -g --prefix "\$_stage" "\$_pkg@latest"/.test(agents) && /mv "\$_stage" "\$_build"/.test(agents), true);
  const skipUses = agentLines.filter((line) => /\bskipped "/.test(line));
  check("and --skip guards the prune, for any harness rather than for kimi", skipUses, ['  if skipped "$_agent"; then']);
  check(
    "each of the four is named to the registry, on the line that installs it",
    AGENT_IDS.filter((id) => !agents.includes(`ensure_npm ${id} ${NPM_PACKAGES[id]} `)),
    [],
  );

  const provenance = blockIn("agents.sh", agentLines, "provenance", "provenance() {", "}");
  const toolchainDef = lineIn("agents.sh", agentLines, "the toolchain directory", "TOOLCHAIN=");
  check("the toolchain is under the home the script was given", toolchainDef, 'TOOLCHAIN="$HOME_DIR/.reemoat/toolchain"');
  const provenanceSpelled = provenance
    .replace(/"\$TOOLCHAIN"/g, toolchainDef.slice('TOOLCHAIN="'.length, -1))
    .replace(/"\$HOME_DIR"/g, "$HOME_DIR")
    .split("\n");
  const classOf = (dir: string): string | undefined => {
    const arm = provenanceSpelled.find((line) => line.includes(`${dir}/*`));
    return arm === undefined ? undefined : /printf '([a-z]*)'/.exec(arm)?.[1];
  };
  check(
    "provenance classifies every directory the daemon searches, by whose it is",
    named.map((dir) => [dir, classOf(dir)]),
    named.map((dir) => [dir, dir.startsWith("$HOME_DIR/.reemoat/") ? "toolchain" : "vendor"]),
  );
  check(
    "reads anywhere else on PATH as outside, and no copy at all as nothing",
    [/^\s*\*\) printf 'outside' ;;$/m.test(provenance), /^\s*""\) printf '' ;;$/m.test(provenance), /command -v "\$1"/.test(provenance)],
    [true, true, true],
  );

  const VENDOR_REFRESH: Record<"claude" | "codex" | "opencode", string> = {
    // The install verb with the flag's channel, never update (Q4.115).
    claude: 'claude install "$CHANNEL"',
    codex: "codex update",
    opencode: "opencode upgrade --method curl",
  };
  for (const id of ["claude", "codex", "opencode"] as const) {
    const fn = `ensure_${id}`;
    const body = blockIn("agents.sh", agentLines, fn, `${fn}() {`, "}");
    const lines = body.split("\n").map((line) => line.trim());
    const arm = (label: string): string => lines.find((line) => line.startsWith(`${label})`)) ?? "";
    const vendorArm = armOf(body, "vendor");
    const esacAt = body.indexOf("\n  esac\n");
    const afterCase = esacAt === -1 ? "" : body.slice(esacAt + "\n  esac\n".length);
    check(`${fn} asks where the copy came from`, [body.includes(`case "$(provenance ${id})" in`), esacAt !== -1], [true, true]);
    check(
      `and a toolchain copy goes back to the registry, whatever the flag says`,
      [arm("toolchain").startsWith(`toolchain) ensure_npm ${id} ${NPM_PACKAGES[id]} "`), arm("toolchain").endsWith('"; return 0 ;;')],
      [true, true],
    );
    check(`an outside copy is named and left`, new RegExp(`^outside\\) outside_note "[^"]*" ${id}; return 0 ;;$`).test(arm("outside")), true);
    check(
      `a vendor copy is refused the registry under --source npm, and otherwise takes the vendor's own verb`,
      [
        new RegExp(`^\\s*if \\[ "\\$SOURCE" = npm \\]; then vendor_copy_stays "[^"]*" ${id}; return 0; fi$`, "m").test(vendorArm),
        vendorArm.includes(VENDOR_REFRESH[id]),
        /failed; keeping \$\(/.test(vendorArm),
        /\bensure_npm\b/.test(vendorArm),
      ],
      [true, true, true, false],
    );
    check(
      `and only an absent ${id} reads the flag: npm behind it, the vendor's download otherwise`,
      [
        new RegExp(`^  if \\[ "\\$SOURCE" = npm \\]; then ensure_npm ${id} ${NPM_PACKAGES[id]} "[^"]*"; return 0; fi$`, "m").test(afterCase),
        new RegExp(`download ${id} https://`).test(afterCase),
        afterCase.includes("install failed; this machine has no copy of it until the next run"),
      ],
      [true, true, true],
    );
  }

  const claudeBody = blockIn("agents.sh", agentLines, "ensure_claude", "ensure_claude() {", "}");
  const claudeCommands = claudeBody.split("\n").filter((line) => !/^\s*#/.test(line));
  check(
    "claude's fresh install and its refresh both take the channel from the flag",
    [/bash "\$TMP\/claude\.sh" "\$CHANNEL"/.test(claudeBody), /claude install "\$CHANNEL"/.test(claudeBody)],
    [true, true],
  );
  check("and neither channel is written into a command in that function", claudeCommands.filter((line) => /\b(stable|latest)\b/.test(line)), []);
  check("the channel defaults to latest, before any flag is read", lineIn("agents.sh", agentLines, "the channel default", "CHANNEL="), "CHANNEL=latest");
  const npmCalls = agentLines.filter((line) => /\bensure_npm\b/.test(line) && !/^ensure_npm\(\)/.test(line));
  const UNCONDITIONAL_NPM = ["kimi", "grok"] as const;
  const npmCallShapes = [
    /^\s*toolchain\) ensure_npm \S+ \S+ "[^"]*"; return 0 ;;$/,
    /^\s*if \[ "\$SOURCE" = npm \]; then ensure_npm \S+ \S+ "[^"]*"; return 0; fi$/,
    /^\s*ensure_npm kimi \S+ "[^"]*"$/,
    // grok takes the npm door because its vendor installer edits shell profiles; kimi because its own updater installs nothing without a TTY.
    /^\s*ensure_npm grok \S+ "[^"]*"$/,
  ];
  check(
    "every reach into the npm arm is a toolchain copy, an absent harness behind the flag, or one of the two that must take it",
    [npmCalls.filter((line) => !npmCallShapes.some((shape) => shape.test(line))), npmCalls.length],
    [[], 2 * (AGENT_IDS.length - UNCONDITIONAL_NPM.length) + UNCONDITIONAL_NPM.length],
  );

  const ensureNpm = blockIn("agents.sh", agentLines, "ensure_npm", "ensure_npm() {", "}");
  const ensureNpmLines = ensureNpm.split("\n").map((line) => line.trim());
  const at = (startsWith: string): number => ensureNpmLines.findIndex((line) => line.startsWith(startsWith));
  check(
    "ensure_npm reads the same answer: absent is an install, toolchain a refresh, anything else somebody else's",
    [
      // Pinned as an order: a guard placed after the install verb would still match both strings.
      at('"") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "$_pad"; return 0; fi') !== -1,
      at('"") if [ "$REFRESH_ONLY" = 1 ]; then not_installed "$_pad"; return 0; fi') < at("_verb=install ;;"),
      ensureNpmLines.includes("toolchain) _verb=refresh ;;"),
      ensureNpmLines.includes('*) outside_note "$_pad" "$_agent"; return 0 ;;'),
    ],
    [true, true, true, true],
  );
  check(
    "a failure is said by what is true afterwards, and that differs by verb",
    [
      at('if [ "$_verb" = refresh ]; then') !== -1,
      at('if [ "$_verb" = refresh ]; then') < at('warn "  $_pad refresh failed; keeping $('),
      at('warn "  $_pad refresh failed; keeping $(') < at('warn "  $_pad install failed; this machine has no copy of it until the next run"'),
    ],
    [true, true, true],
  );
  const nodeRead = at(`_ver=$("$_node" -p 'require(process.argv[1]).version'`);
  const sedRead = at(`[ -n "$_ver" ] || _ver=$(grep -o '"version": *"[^"]*"' "$_manifest" 2>/dev/null | head -1 | sed`);
  const clockRead = at('[ -n "$_ver" ] || _ver=$(date +');
  check("the version is read as JSON by node first, then as the first version key on the file, then off the clock", [nodeRead !== -1, sedRead > nodeRead, clockRead > sedRead], [true, true, true]);
  check("with the node beside the npm that installed it", ensureNpmLines.includes('_node=$(dirname -- "$(command -v "$_npm")")/node'), true);
  const prevAt = at('_prev=$(readlink "$TOOLCHAIN/bin/$_agent" 2>/dev/null || true)');
  check(
    "ensure_npm reads the build the symlink named before anything moves, and the prune spares it",
    [prevAt !== -1, prevAt < at('case "$(provenance "$_agent")" in'), ensureNpmLines.includes('_prev=${_prev%/bin/*}'), blockIn("agents.sh", agentLines, "prune_builds", "prune_builds() {", "}").includes('[ -d "$_d" ] && [ "$_d" != "$_build" ] && [ "$_d" != "$_prev" ] && rm -rf "$_d"')],
    [true, true, true, true],
  );
  const viewAt = at('_latest=$("$_npm" view "$_pkg@latest" version 2>/dev/null || true)');
  check(
    "a refresh asks the registry for the version before staging, and only a refresh",
    [
      viewAt !== -1,
      at('if [ "$_verb" = refresh ] && [ -n "$_cur" ]; then') < viewAt,
      viewAt < at('_stage=$(mktemp -d "$TOOLCHAIN/$_agent.stage.XXXXXX")'),
      ensureNpmLines.includes('if [ -n "$_latest" ] && [ "$_latest" = "$_cur" ]; then'),
      ensureNpmLines.includes('done_note "$_pad" current "$_agent"'),
      at('if [ "$CHECK" = 1 ]; then') < viewAt,
    ],
    [true, true, true, true, true, true],
  );
  const stays = blockIn("agents.sh", agentLines, "vendor_copy_stays", "vendor_copy_stays() {", "}");
  check(
    "a vendor copy under --source npm is a warning naming the path and the remedy, and it counts",
    [
      /^\s*warn "  \$1 \$\("\$2" --version[^\n]* at \$\(command -v "\$2"\) was installed by the vendor's installer, which --source npm does not reach; remove it and the next run installs from the npm registry"$/m.test(stays),
      stays.includes("failed=$((failed + 1))"),
    ],
    [true, true],
  );
  check(
    "and the summary counts the harnesses this run walked, not the roster",
    [
      agents.includes('warn "  $failed of $attempted agents were not installed or refreshed; the lines above say why"'),
      agents.includes(`of ${AGENT_IDS.length} agents were not installed`),
    ],
    [true, false],
  );
  // Compared as a set: the script's cheapest-first order is deliberate.
  const scriptAgents = (agents.match(/^AGENTS="([^"]*)"/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
  check(
    "the script's harness list is the daemon's, as a set",
    [[...scriptAgents].sort(), scriptAgents.length],
    [[...AGENT_IDS].sort(), AGENT_IDS.length],
  );

  // Fake npm: answers only the shapes ensure_npm calls, for NPM_PACKAGES only; anything else exits 3.
  // The real node is linked beside it because ensure_npm reads manifests with the node next to the npm it found.
  const agentsPath = join(repoRoot, "deploy/agents.sh");
  const agentsHome = join(sandbox, "agents-home");
  const agentsStubs = join(sandbox, "agents-stubs");
  mkdirSync(agentsHome, { recursive: true });
  mkdirSync(agentsStubs, { recursive: true });
  writeFileSync(
    join(agentsStubs, "npm"),
    [
      "#!/bin/sh",
      '[ -z "${FAKE_LOG:-}" ] || printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
      'if [ "$1" = view ]; then',
      '  [ "$#" = 3 ] && [ "$3" = version ] || { echo "fake npm: unexpected argv: $*" >&2; exit 3; }',
      '  pkg=${2%@latest}',
      '  [ "$pkg" != "$2" ] || { echo "fake npm: not @latest: $2" >&2; exit 3; }',
      '  [ "$pkg" != "${FAKE_FAIL:-}" ] || exit 1',
      '  [ "${FAKE_VIEW_FAIL:-}" != 1 ] || exit 1',
      '  case "$pkg" in',
      ...AGENT_IDS.map((id) => `    ${NPM_PACKAGES[id]}) ;;`),
      '    *) echo "fake npm: unknown package $pkg" >&2; exit 3 ;;',
      "  esac",
      '  echo "${FAKE_VER:-1.0.0}"',
      "  exit 0",
      "fi",
      '[ "$#" = 5 ] && [ "$1" = i ] && [ "$2" = -g ] && [ "$3" = --prefix ] || { echo "fake npm: unexpected argv: $*" >&2; exit 3; }',
      'prefix=$4',
      'pkg=${5%@latest}',
      '[ "$pkg" != "$5" ] || { echo "fake npm: not @latest: $5" >&2; exit 3; }',
      '[ "$pkg" != "${FAKE_FAIL:-}" ] || exit 1',
      'case "$pkg" in',
      ...AGENT_IDS.map((id) => `  ${NPM_PACKAGES[id]}) agent=${id} ;;`),
      '  *) echo "fake npm: unknown package $pkg" >&2; exit 3 ;;',
      "esac",
      'mkdir -p "$prefix/bin" "$prefix/lib/node_modules/$pkg"',
      "printf '#!/bin/sh\\necho %s\\n' \"${FAKE_VER:-1.0.0}\" > \"$prefix/bin/$agent\"",
      'chmod 755 "$prefix/bin/$agent"',
      "printf '{\"name\":\"%s\",\"version\":\"%s\"}\\n' \"$pkg\" \"${FAKE_VER:-1.0.0}\" > \"$prefix/lib/node_modules/$pkg/package.json\"",
      "",
    ].join("\n"),
  );
  chmodSync(join(agentsStubs, "npm"), 0o755);
  symlinkSync(process.execPath, join(agentsStubs, "node"));
  const runAgents = (args: string[], env: Record<string, string> = {}): Run => {
    const run = spawnSync("sh", [agentsPath, ...args], {
      encoding: "utf8",
      env: { HOME: agentsHome, PATH: `/usr/bin:/bin:${agentsStubs}`, TMPDIR: sandbox, ...env },
      input: "",
      timeout: 60_000,
    });
    return { status: run.status ?? -1, out: run.stdout ?? "", err: run.stderr ?? "" };
  };
  check("an unknown flag is refused with 2", runAgents(["--bogus"]).status, 2);
  const bareSkip = runAgents(["--skip"]);
  check("and so is --skip with no name", [bareSkip.status, bareSkip.err.includes("--skip needs an agent name")], [2, true]);
  const bareOnly = runAgents(["--check", "--only"]);
  check("and --only with no name", [bareOnly.status, bareOnly.err.includes("--only needs an agent name")], [2, true]);
  const eaten = runAgents(["--only", "--check"]);
  check("and a flag in --only's value slot is refused, not swallowed", [eaten.status, eaten.err.includes("not --check")], [2, true]);
  // The --only/--skip asymmetry is deliberate: a mistyped --only would exit 0 and read as installed.
  const badOnly = runAgents(["--only", "gemini", "--check"]);
  check(
    "an --only naming a harness this script does not install is refused with 2, by name",
    [badOnly.status, badOnly.err.includes("--only takes one of"), badOnly.err.includes("not gemini")],
    [2, true, true],
  );
  // Every refusal runs under --check, so a parser that stopped refusing lists instead of downloading from vendors.
  const badSource = runAgents(["--check", "--source", "bogus"]);
  check("--source with a value it does not know is refused by name", [badSource.status, badSource.err.includes("--source takes vendor or npm, not bogus")], [2, true]);
  const bareSource = runAgents(["--check", "--source"]);
  check("and so is --source with no value", [bareSource.status, bareSource.err.includes("--source needs vendor or npm")], [2, true]);
  const badChannel = runAgents(["--check", "--channel", "bogus"]);
  check("--channel with a value it does not know is refused by name", [badChannel.status, badChannel.err.includes("--channel takes stable or latest, not bogus")], [2, true]);
  const bareChannel = runAgents(["--check", "--channel"]);
  check("and so is --channel with no value", [bareChannel.status, bareChannel.err.includes("--channel needs stable or latest")], [2, true]);
  const dry = runAgents(["--check", "--skip", "kimi"]);
  check("--check exits 0 and says nothing will be changed", [dry.status, dry.out.includes("nothing will be changed")], [0, true]);
  check("and which installer it would have used", dry.out.includes("with each vendor's own installer"), true);
  check(
    "and claims only what would happen",
    [/claude\s+would install/.test(dry.out), /would download https:\/\/claude\.ai/.test(dry.out), /installed/.test(dry.out.replace(/would install/g, ""))],
    [true, true, false],
  );
  check(
    "and which channel claude would follow, in the header and on the install line",
    [dry.out.includes("claude on its latest channel"), /^  claude: would run: bash \S+\/claude\.sh latest$/m.test(dry.out)],
    [true, true],
  );
  const dryStable = runAgents(["--check", "--channel", "stable"]);
  check(
    "with --channel stable said in both places instead",
    [dryStable.status, dryStable.out.includes("claude on its stable channel"), /^  claude: would run: bash \S+\/claude\.sh stable$/m.test(dryStable.out), /claude[^\n]*latest/.test(dryStable.out)],
    [0, true, true, false],
  );
  check("with kimi named as an install into its own directory", /kimi-<version>/.test(dry.out), true);
  const ownKimi = join(sandbox, "own-kimi");
  mkdirSync(ownKimi, { recursive: true });
  writeFileSync(join(ownKimi, "kimi"), "#!/bin/sh\necho 0.29.2\n");
  chmodSync(join(ownKimi, "kimi"), 0o755);
  const outside = runAgents(["--check"], { PATH: `/usr/bin:/bin:${agentsStubs}:${ownKimi}` });
  check("an operator's own kimi is named and left alone", /kimi\s+0\.29\.2 — installed outside reemoat/.test(outside.out), true);
  const pinnedRun = runAgents(["--check"], { CLAUDE_CODE_EXECUTABLE: "/x/claude", CODEX_PATH: "/x/codex" });
  check(
    "and so is a harness whose binary an operator named",
    [/claude\s+left alone/.test(pinnedRun.out), /codex\s+left alone/.test(pinnedRun.out), /claude\s+would/.test(pinnedRun.out)],
    [true, true, false],
  );

  const npmDry = runAgents(["--check", "--source", "npm"]);
  check("--check --source npm exits 0 and names the registry", [npmDry.status, npmDry.out.includes("from the npm registry")], [0, true]);
  check("and names no channel, since no arm under npm reads one", /channel/.test(npmDry.out), false);
  const npmStable = runAgents(["--check", "--source", "npm", "--channel", "stable"]);
  check(
    "under --source npm a channel the registry cannot honour is said not to apply",
    [npmStable.status, npmStable.out.includes("--channel stable does not apply under --source npm")],
    [0, true],
  );
  check("and the default channel under npm says nothing about applying", /does not apply/.test(npmDry.out), false);
  check(
    "and says, per harness, which package into which directory",
    AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g --prefix \\S*/${id}-<version> ${NPM_PACKAGES[id]}@latest, then repoint \\S*/bin/${id}$`, "m").test(npmDry.out)),
    [],
  );
  check("and that each would be an install", AGENT_IDS.filter((id) => !new RegExp(`^  ${id}\\s+would install$`, "m").test(npmDry.out)), []);
  check("with nothing fetched from a vendor", /would download|claude install|codex update|opencode upgrade/.test(npmDry.out), false);
  // Fake claude: --version, and install stable|latest logged to FAKE_LOG (refused under FAKE_CLAUDE_REFUSE); any other argv exits 3.
  const claudeStub = (at: string): void => {
    writeFileSync(
      at,
      [
        "#!/bin/sh",
        '[ -z "${FAKE_LOG:-}" ] || printf \'claude %s\\n\' "$*" >> "$FAKE_LOG"',
        'case "$1" in',
        "  --version) echo '2.1.259 (Claude Code)' ;;",
        '  install) [ "$#" = 2 ] || { echo "fake claude: unexpected argv: $*" >&2; exit 3; }',
        '    case "$2" in stable | latest) ;; *) echo "fake claude: unknown channel $2" >&2; exit 3 ;; esac',
        '    [ -z "${FAKE_CLAUDE_REFUSE:-}" ] || { echo "fake claude: refusing install $2" >&2; exit 1; } ;;',
        '  *) echo "fake claude: unexpected argv: $*" >&2; exit 3 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(at, 0o755);
  };
  const ownClaude = join(sandbox, "own-claude");
  mkdirSync(ownClaude, { recursive: true });
  claudeStub(join(ownClaude, "claude"));
  const npmOutside = runAgents(["--check", "--source", "npm"], { PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "under npm an operator's own claude is named and left alone",
    [/claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here/.test(npmOutside.out), /claude: would run/.test(npmOutside.out)],
    [true, false],
  );
  check("while the other three would still be installed", ["codex", "opencode", "kimi"].filter((id) => !new RegExp(`^  ${id}: would run: `, "m").test(npmOutside.out)), []);
  const npmPinned = runAgents(["--check", "--source", "npm"], { CLAUDE_CODE_EXECUTABLE: "/x/claude", CODEX_PATH: "/x/codex" });
  check(
    "and so is a harness whose binary an operator named",
    [/claude\s+left alone/.test(npmPinned.out), /codex\s+left alone/.test(npmPinned.out), /(claude|codex): would run/.test(npmPinned.out), /kimi: would run/.test(npmPinned.out)],
    [true, true, false, true],
  );
  const vendorOutside = runAgents(["--check"], { PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "and under vendor an operator's own claude is the same sentence, and no verb",
    [/claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here/.test(vendorOutside.out), /claude: would run|claude\s+would/.test(vendorOutside.out)],
    [true, false],
  );

  const toolchainOf = (h: string): string => join(h, ".reemoat", "toolchain");
  const buildsOf = (h: string, id: string): string[] =>
    existsSync(toolchainOf(h))
      ? readdirSync(toolchainOf(h)).filter((name) => name.startsWith(`${id}-`) || name.startsWith(`${id}.stage.`)).sort()
      : [];
  const linkOf = (h: string, id: string): string | null => {
    try {
      return readlinkSync(join(toolchainOf(h), "bin", id));
    } catch {
      // No symlink at all is an answer the cases below want, not an error.
      return null;
    }
  };
  const buildOf = (h: string, id: string, ver: string): string => join(toolchainOf(h), `${id}-${ver}`, "bin", id);
  const saysEach = (out: string, verb: string, ver: string, ids: readonly string[] = AGENT_IDS): string[] =>
    ids.filter((id) => !new RegExp(`^  ${id}\\s+${verb} ${ver.replace(/\./g, "\\.")}$`, "m").test(out));

  const npmHome = join(sandbox, "agents-npm-home");
  mkdirSync(npmHome, { recursive: true });
  const first = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "1.0.0" });
  check("--source npm on a fresh home exits 0 with nothing on stderr", [first.status, first.err], [0, ""]);
  check("and installs all four, each into a directory named by its build", AGENT_IDS.map((id) => buildsOf(npmHome, id)), AGENT_IDS.map((id) => [`${id}-1.0.0`]));
  check("each reached through a symlink under bin", AGENT_IDS.map((id) => linkOf(npmHome, id)), AGENT_IDS.map((id) => buildOf(npmHome, id, "1.0.0")));
  check("that runs", spawnSync(join(toolchainOf(npmHome), "bin", "claude"), ["--version"], { encoding: "utf8" }).stdout, "1.0.0\n");
  check("and each says it was an install, with the build it now runs", saysEach(first.out, "install", "1.0.0"), []);

  const second = runAgents(["--source", "npm", "--skip", "claude"], { HOME: npmHome, FAKE_VER: "2.0.0" });
  check("a newer build on the registry is a refresh of all four", [second.status, second.err, saysEach(second.out, "refresh", "2.0.0")], [0, "", []]);
  check("that repoints every symlink", AGENT_IDS.map((id) => linkOf(npmHome, id)), AGENT_IDS.map((id) => buildOf(npmHome, id, "2.0.0")));
  check(
    "keeps the build a live agent may be on, and says so",
    [buildsOf(npmHome, "claude"), /^  claude\s+previous build kept: an agent is using it$/m.test(second.out)],
    [["claude-1.0.0", "claude-2.0.0"], true],
  );
  check(
    "and keeps the build the symlink named when the run began for the other three, without a note",
    [["codex", "opencode", "kimi"].map((id) => buildsOf(npmHome, id)), (second.out.match(/previous build kept/g) ?? []).length],
    [[["codex-1.0.0", "codex-2.0.0"], ["opencode-1.0.0", "opencode-2.0.0"], ["kimi-1.0.0", "kimi-2.0.0"]], 1],
  );

  const codexInode = statSync(join(toolchainOf(npmHome), "codex-2.0.0")).ino;
  const thirdLog = join(sandbox, "agents-npm-third.log");
  const third = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "2.0.0", FAKE_LOG: thirdLog });
  check("the same build again is current, and moves nothing", [third.status, third.err, saysEach(third.out, "current", "2.0.0")], [0, "", []]);
  check(
    "having asked the registry once per harness and staged nothing",
    readFileSync(thirdLog, "utf8").trim().split("\n").sort(),
    AGENT_IDS.map((id) => `view ${NPM_PACKAGES[id]}@latest version`).sort(),
  );
  check("leaving the directory that was already there", statSync(join(toolchainOf(npmHome), "codex-2.0.0")).ino, codexInode);
  check("and exactly one build per harness, the kept one pruned now that nothing is on it", AGENT_IDS.map((id) => buildsOf(npmHome, id)), AGENT_IDS.map((id) => [`${id}-2.0.0`]));
  check("with every symlink where it was", AGENT_IDS.map((id) => linkOf(npmHome, id)), AGENT_IDS.map((id) => buildOf(npmHome, id, "2.0.0")));

  const viewFailLog = join(sandbox, "agents-npm-viewfail.log");
  const viewFail = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "2.0.0", FAKE_VIEW_FAIL: "1", FAKE_LOG: viewFailLog });
  check(
    "a view the registry refuses falls through to staging, and the same build is a refresh that moves nothing",
    [viewFail.status, viewFail.err, saysEach(viewFail.out, "refresh", "2.0.0"), readFileSync(viewFailLog, "utf8").split("\n").filter((line) => line.startsWith("i -g ")).length, statSync(join(toolchainOf(npmHome), "codex-2.0.0")).ino, AGENT_IDS.map((id) => buildsOf(npmHome, id))],
    [0, "", [], AGENT_IDS.length, codexInode, AGENT_IDS.map((id) => [`${id}-2.0.0`])],
  );

  const prevHome = join(sandbox, "agents-prev-home");
  mkdirSync(prevHome, { recursive: true });
  const v1 = runAgents(["--source", "npm"], { HOME: prevHome, FAKE_VER: "1.0.0" });
  const v2 = runAgents(["--source", "npm"], { HOME: prevHome, FAKE_VER: "2.0.0" });
  check(
    "after v1 then v2 with no --skip, v1 is still on disk and v2 is linked",
    [v1.status, v2.status, v2.err, AGENT_IDS.map((id) => buildsOf(prevHome, id)), AGENT_IDS.map((id) => linkOf(prevHome, id))],
    [0, 0, "", AGENT_IDS.map((id) => [`${id}-1.0.0`, `${id}-2.0.0`]), AGENT_IDS.map((id) => buildOf(prevHome, id, "2.0.0"))],
  );
  const v3Log = join(sandbox, "agents-prev-v3.log");
  const v3 = runAgents(["--source", "npm"], { HOME: prevHome, FAKE_VER: "3.0.0", FAKE_LOG: v3Log });
  check(
    "after v3, v1 is gone, v2 — the build the symlink named when the run began — remains, and v3 is linked",
    [v3.status, v3.err, AGENT_IDS.map((id) => buildsOf(prevHome, id)), AGENT_IDS.map((id) => linkOf(prevHome, id))],
    [0, "", AGENT_IDS.map((id) => [`${id}-2.0.0`, `${id}-3.0.0`]), AGENT_IDS.map((id) => buildOf(prevHome, id, "3.0.0"))],
  );
  check(
    "a newer version on the registry is asked about, then staged",
    [readFileSync(v3Log, "utf8").split("\n").filter((line) => line.startsWith("view ")).length, readFileSync(v3Log, "utf8").split("\n").filter((line) => line.startsWith("i -g ")).length, saysEach(v3.out, "refresh", "3.0.0")],
    [AGENT_IDS.length, AGENT_IDS.length, []],
  );
  const v3againLog = join(sandbox, "agents-prev-v3again.log");
  const v3again = runAgents(["--source", "npm"], { HOME: prevHome, FAKE_VER: "3.0.0", FAKE_LOG: v3againLog });
  check(
    "and the same build again is current, stages nothing, and prunes v2, since the symlink named v3 when it began",
    [v3again.status, saysEach(v3again.out, "current", "3.0.0"), readFileSync(v3againLog, "utf8").split("\n").filter((line) => line.startsWith("i -g ")).length, AGENT_IDS.map((id) => buildsOf(prevHome, id))],
    [0, [], 0, AGENT_IDS.map((id) => [`${id}-3.0.0`])],
  );

  const pipeHome = join(sandbox, "agents-pipe-home");
  const pipeTmp = join(sandbox, "agents-pipe-tmp");
  mkdirSync(pipeHome, { recursive: true });
  mkdirSync(pipeTmp, { recursive: true });
  const piped = spawnSync("sh", ["-c", '{ sh "$1" --source npm; echo "rc=$?" >&2; } | head -n 1', "sh", agentsPath], {
    encoding: "utf8",
    env: { HOME: pipeHome, PATH: `/usr/bin:/bin:${agentsStubs}`, TMPDIR: pipeTmp, FAKE_VER: "1.0.0" },
    input: "",
    timeout: 60_000,
  });
  check(
    "a run whose reader exits after one line still installs all four, exits 0 and cleans up",
    [
      piped.stderr,
      AGENT_IDS.map((id) => buildsOf(pipeHome, id)),
      AGENT_IDS.map((id) => linkOf(pipeHome, id)),
      readdirSync(pipeTmp),
      existsSync(join(toolchainOf(pipeHome), ".agents.lock")),
    ],
    ["rc=0\n", AGENT_IDS.map((id) => [`${id}-1.0.0`]), AGENT_IDS.map((id) => buildOf(pipeHome, id, "1.0.0")), [], false],
  );

  const lockHome = join(sandbox, "agents-lock-home");
  const lockDir = join(toolchainOf(lockHome), ".agents.lock");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
  const held = runAgents(["--source", "npm"], { HOME: lockHome, FAKE_VER: "1.0.0" });
  check(
    "a lock held by a live pid is a sentence naming it, exit 0, nothing changed and the lock left alone",
    [held.status, held.err, held.out, AGENT_IDS.map((id) => buildsOf(lockHome, id)), readFileSync(join(lockDir, "pid"), "utf8")],
    [0, `another run of deploy/agents.sh (pid ${process.pid}) is in progress; nothing was changed\n`, "", AGENT_IDS.map(() => []), `${process.pid}\n`],
  );
  const heldCheck = runAgents(["--source", "npm", "--check"], { HOME: lockHome });
  check("while --check needs no lock and previews past one", [heldCheck.status, heldCheck.err, heldCheck.out.includes("nothing will be changed")], [0, "", true]);
  writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
  const heldLoud = runAgents(["--source", "npm", "--fail-if-locked"], { HOME: lockHome, FAKE_VER: "1.0.0" });
  check(
    "a contended run exits 3 under --fail-if-locked, with the same sentence and nothing installed",
    [heldLoud.status, heldLoud.err.includes("is in progress; nothing was changed"), heldLoud.out, AGENT_IDS.map((id) => buildsOf(lockHome, id))],
    [3, true, "", AGENT_IDS.map(() => [])],
  );
  // --refresh-only is asserted as an absence over the whole transcript: only that catches a door somebody forgot.
  const bareHome = join(sandbox, "agents-bare-home");
  mkdirSync(bareHome, { recursive: true });
  const refreshOnly = runAgents(["--refresh-only", "--check"], { HOME: bareHome });
  const INSTALL_VERBS = /would download|npm i -g|claude install|codex update|opencode upgrade|would install/;
  check(
    "--refresh-only on a machine with no harness installs nothing, from any door",
    [
      refreshOnly.status,
      INSTALL_VERBS.test(refreshOnly.out),
      INSTALL_VERBS.test(refreshOnly.err),
      AGENT_IDS.every((id) => refreshOnly.out.includes(`${id} `) || refreshOnly.out.includes(`${id}\n`)),
    ],
    [0, false, false, true],
  );
  check(
    "and says so per harness rather than silently doing nothing",
    (refreshOnly.out.match(/not installed; --refresh-only fetches nothing new/g) ?? []).length,
    AGENT_IDS.length,
  );
  check("and none of it is counted as a failure", [refreshOnly.err, refreshOnly.err.includes("were not installed or refreshed")], ["", false]);
  const refreshHome = join(sandbox, "agents-refresh-home");
  const refreshClaude = join(refreshHome, ".local", "bin", "claude");
  mkdirSync(dirname(refreshClaude), { recursive: true });
  claudeStub(refreshClaude);
  const stillRefreshes = runAgents(["--refresh-only", "--check"], { HOME: refreshHome });
  check(
    "while a copy that is there is still refreshed",
    [
      /^  claude: would run: claude install latest$/m.test(stillRefreshes.out),
      stillRefreshes.out.includes("claude        not installed"),
    ],
    [true, false],
  );
  const stepHome = join(sandbox, "agents-step-home");
  mkdirSync(stepHome, { recursive: true });
  const stepped = runAgents(["--only", "kimi", "--source", "npm"], { HOME: stepHome, FAKE_VER: "1.0.0" });
  const stepLines = stepped.out.split("\n").filter((line) => line.startsWith("step:"));
  check(
    "a real run prints checkpoints, and every one of them parses",
    [stepLines.length > 0, stepLines.every((line) => readStep(line) !== null)],
    [true, true],
  );
  check(
    "they are this harness's, and they run start → … → done",
    [
      stepLines.every((line) => readStep(line)?.agent === "kimi"),
      readStep(stepLines[0] ?? "")?.phase,
      readStep(stepLines.at(-1) ?? "")?.phase,
    ],
    [true, "start", "done"],
  );
  check(
    "while --check emits none, having performed none",
    runAgents(["--only", "kimi", "--check"], { HOME: stepHome }).out.includes("step:"),
    false,
  );

  const narrowed = runAgents(["--only", "codex", "--refresh-only", "--check"], { HOME: refreshHome });
  check(
    "--only narrows the walk, and the header names both modes",
    [
      narrowed.out.includes("codex only"),
      narrowed.out.includes("refresh only, nothing new is installed"),
      narrowed.out.includes("claude"),
      narrowed.out.includes("claude on its latest channel"),
    ],
    [true, true, false, false],
  );

  // A pid past any pid_max. Required to be ESRCH, since kill -0 on a live pid another uid owns fails too (EPERM).
  const gone = "4194305";
  const pidState = (pid: number): string => {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code ?? "unknown";
    }
  };
  check("the pid this lock names is no process at all, which is what makes it stale", pidState(Number(gone)), "ESRCH");
  writeFileSync(join(lockDir, "pid"), `${gone}\n`);
  const stale = runAgents(["--source", "npm"], { HOME: lockHome, FAKE_VER: "1.0.0" });
  check(
    "a lock whose pid is gone is taken over, and released at the end",
    [stale.status, stale.err, AGENT_IDS.map((id) => buildsOf(lockHome, id)), existsSync(lockDir)],
    [0, "", AGENT_IDS.map((id) => [`${id}-1.0.0`]), false],
  );
  mkdirSync(lockDir, { recursive: true });
  const empty = runAgents(["--source", "npm"], { HOME: lockHome, FAKE_VER: "2.0.0" });
  check("and so is one with no pid in it, after a second's grace", [empty.status, empty.err, saysEach(empty.out, "refresh", "2.0.0"), existsSync(lockDir)], [0, "", [], false]);

  const refused = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "2.0.0", FAKE_FAIL: NPM_PACKAGES.codex });
  check(
    "a refresh the registry refuses warns, naming the build kept, exit 0",
    [refused.status, /^  codex\s+refresh failed; keeping 2\.0\.0$/m.test(refused.err), refused.err.includes(`1 of ${AGENT_IDS.length} agents were not installed or refreshed`)],
    [0, true, true],
  );
  check("with the symlink still on that build and no stage left behind", [linkOf(npmHome, "codex"), buildsOf(npmHome, "codex")], [buildOf(npmHome, "codex", "2.0.0"), ["codex-2.0.0"]]);
  check("and the other three current regardless", saysEach(refused.out, "current", "2.0.0", ["claude", "opencode", "kimi"]), []);

  const backThroughNpm = runAgents(["--source", "vendor", "--check"], { HOME: npmHome });
  check(
    "under --source vendor a copy npm installed is still refreshed from npm",
    [
      backThroughNpm.status,
      backThroughNpm.out.includes("with each vendor's own installer"),
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would ask the registry for ${NPM_PACKAGES[id].replace(/[@/.]/g, "\\$&")}@latest, and stage nothing if it is still 2\\.0\\.0$`, "m").test(backThroughNpm.out)),
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g --prefix \\S*/${id}-<version> ${NPM_PACKAGES[id]}@latest, then repoint \\S*/bin/${id}$`, "m").test(backThroughNpm.out)),
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}\\s+would refresh$`, "m").test(backThroughNpm.out)),
      /would download|claude install|codex update|opencode upgrade/.test(backThroughNpm.out),
    ],
    [0, true, [], [], [], false],
  );

  const vendorHome = join(sandbox, "agents-vendor-home");
  const vendorClaude = join(vendorHome, ".local", "bin", "claude");
  mkdirSync(dirname(vendorClaude), { recursive: true });
  claudeStub(vendorClaude);
  const staysWarning = ` at ${vendorClaude} was installed by the vendor's installer, which --source npm does not reach; remove it and the next run installs from the npm registry`;
  const vendorCopy = runAgents(["--source", "npm"], { HOME: vendorHome, FAKE_VER: "1.0.0" });
  check(
    "a vendor-installed claude under --source npm is a warning on stderr, naming the path and the remedy",
    [vendorCopy.status, /^  claude\s+2\.1\.259 \(Claude Code\) at /m.test(vendorCopy.err), vendorCopy.err.includes(staysWarning)],
    [0, true, true],
  );
  check("counted as one the run could not refresh", vendorCopy.err.includes(`1 of ${AGENT_IDS.length} agents were not installed or refreshed`), true);
  check(
    "with nothing installed beside it, while the other three are",
    [buildsOf(vendorHome, "claude"), linkOf(vendorHome, "claude"), saysEach(vendorCopy.out, "install", "1.0.0", ["codex", "opencode", "kimi"])],
    [[], null, []],
  );
  check("and --check says the same, since it is a refusal and not an act", runAgents(["--source", "npm", "--check"], { HOME: vendorHome }).err.includes(staysWarning), true);
  const vendorDoor = runAgents(["--source", "vendor", "--check"], { HOME: vendorHome });
  check(
    "under --source vendor the same copy is refreshed by the vendor's own verb, on the default channel",
    [vendorDoor.status, vendorDoor.err, /^  claude: would run: claude install latest$/m.test(vendorDoor.out), /^  claude\s+would refresh$/m.test(vendorDoor.out)],
    [0, "", true, true],
  );
  check("while the three npm installed beside it go back to npm", ["codex", "opencode", "kimi"].filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g`, "m").test(vendorDoor.out)), []);
  const channelLog = join(sandbox, "agents-channel-log");
  const stableRun = runAgents(["--source", "vendor", "--channel", "stable"], { HOME: vendorHome, FAKE_VER: "1.0.0", FAKE_LOG: channelLog });
  const claudeAsked = (log: string): string[] =>
    (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((line) => line.startsWith("claude ") && !line.startsWith("claude --version"));
  check(
    "a real refresh hands claude's own install verb the channel it was given",
    [stableRun.status, stableRun.err, claudeAsked(channelLog), /^  claude\s+refresh 2\.1\.259 \(Claude Code\)$/m.test(stableRun.out)],
    [0, "", ["claude install stable"], true],
  );
  rmSync(channelLog, { force: true });
  const latestRun = runAgents(["--source", "vendor"], { HOME: vendorHome, FAKE_VER: "1.0.0", FAKE_LOG: channelLog });
  check(
    "and with no flag the verb is told latest outright, never left to claude's own setting",
    [latestRun.status, latestRun.err, claudeAsked(channelLog), /^  claude\s+refresh 2\.1\.259 \(Claude Code\)$/m.test(latestRun.out)],
    [0, "", ["claude install latest"], true],
  );
  rmSync(channelLog, { force: true });
  const refusedChannel = runAgents(["--source", "vendor", "--channel", "stable"], { HOME: vendorHome, FAKE_VER: "1.0.0", FAKE_LOG: channelLog, FAKE_CLAUDE_REFUSE: "1" });
  check(
    "a refresh claude's own verb refuses warns naming that verb, its channel and the build kept, exit 0",
    [
      refusedChannel.status,
      /^  claude\s+install stable failed; keeping 2\.1\.259 \(Claude Code\)$/m.test(refusedChannel.err),
      refusedChannel.err.includes(`1 of ${AGENT_IDS.length} agents were not installed or refreshed`),
      claudeAsked(channelLog),
    ],
    [0, true, true, ["claude install stable"]],
  );

  const outsideHome = join(sandbox, "agents-outside-home");
  mkdirSync(outsideHome, { recursive: true });
  const outsideRun = runAgents(["--source", "npm"], { HOME: outsideHome, FAKE_VER: "1.0.0", PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "a run under npm installs nothing beside an operator's own claude, and says whose it is",
    [outsideRun.status, outsideRun.err, /^  claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here$/m.test(outsideRun.out), buildsOf(outsideHome, "claude"), saysEach(outsideRun.out, "install", "1.0.0", ["codex", "opencode", "kimi"])],
    [0, "", true, [], []],
  );

  const failHome = join(sandbox, "agents-fail-home");
  mkdirSync(failHome, { recursive: true });
  const noCopy = runAgents(["--source", "npm"], { HOME: failHome, FAKE_VER: "1.0.0", FAKE_FAIL: NPM_PACKAGES.claude });
  check(
    "an install the registry refuses says what that costs now, exit 0",
    [noCopy.status, /^  claude\s+install failed; this machine has no copy of it until the next run$/m.test(noCopy.err), noCopy.err.includes(`1 of ${AGENT_IDS.length} agents were not installed or refreshed`)],
    [0, true, true],
  );
  check("and leaves no half-made build, no symlink and no stage", [buildsOf(failHome, "claude"), linkOf(failHome, "claude"), existsSync(join(toolchainOf(failHome), "bin", "claude"))], [[], null, false]);
  check(
    "while the other three are installed",
    AGENT_IDS.filter((id) => id !== "claude").map((id) => buildsOf(failHome, id)),
    AGENT_IDS.filter((id) => id !== "claude").map((id) => [`${id}-1.0.0`]),
  );

  // A truncated download must define functions and do nothing, so main runs only from the last line.
  const agentCode = agentLines.filter((line) => line.trim().length > 0);
  check("everything runs from one call on the last line", agentCode.at(-1), 'main "$@"');
  check("and nothing else calls it", agentCode.filter((line) => /^main /.test(line)).length, 1);

  // Order is the assertion: hand_off starts the daemon, so the agents step must come first.
  const boot = readFileSync(join(repoRoot, "deploy/bootstrap.sh"), "utf8");
  const bootLines = boot.split("\n");
  const bootBody = bootLines.filter((line) => !/^\s*#/.test(line));
  check("the installer defines the agent step", bootBody.filter((line) => /^install_agents\(\)/.test(line)).length, 1);
  const callsAgents = bootBody.findIndex((line) => /^\s+install_agents$/.test(line));
  const callsHandOff = bootBody.findIndex((line) => /^\s+hand_off$/.test(line));
  check("and calls it exactly once", bootBody.filter((line) => /^\s+install_agents$/.test(line)).length, 1);
  check(
    "before the unit is rendered and the daemon started",
    callsAgents > 0 && callsHandOff > 0 && callsAgents < callsHandOff,
    true,
  );

  const bootFn = (name: string): string => blockIn("bootstrap.sh", bootLines, name, `${name}() {`, "}");

  const probeInstance = bootFn("probe_instance");
  const credentialBody = bootFn("credential_body");
  const registerFn = bootFn("register");
  check(
    "the installer reads whether the instance publishes documents",
    /REG_LEGAL=\$\(json_path legal\.documents/.test(probeInstance),
    true,
  );
  check(
    "and asks for agreement on the tty before creating an account",
    [/\[ "\$REG_LEGAL" = true \]/.test(registerFn), registerFn.includes("$CP/terms"), /_agree.*=.*yes/.test(registerFn)],
    [true, true, true],
  );
  check(
    "and sends acceptedTerms only when it was asked for",
    [/acceptedTerms = true/.test(credentialBody), /accepted === "yes"/.test(credentialBody)],
    [true, true],
  );
  check("the bootstrap defaults the agent source", lineIn("bootstrap.sh", bootLines, "the agent-source default", "AGENT_SOURCE="), "AGENT_SOURCE=vendor");
  const parseFlags = bootFn("parse_flags");
  check(
    "and parse_flags takes --agent-source, refusing any third spelling by name",
    [/--agent-source\)/.test(parseFlags), /vendor \| npm\) ;;/.test(parseFlags), parseFlags.includes('die "--agent-source takes vendor or npm, not $AGENT_SOURCE"')],
    [true, true, true],
  );
  check("usage documents the flag and both values", [/--agent-source <src>/.test(bootFn("usage")), /`vendor`/.test(bootFn("usage")), /`npm`/.test(bootFn("usage"))], [true, true, true]);
  check("install_agents passes it to the script as --source", bootFn("install_agents").includes('"$CHECKOUT/deploy/agents.sh" --source "$AGENT_SOURCE"'), true);
  const writeEnv = bootFn("write_env_file");
  check(
    "and write_env_file writes it for the daemon only when it is npm",
    [
      bootBody.filter((line) => /set_env REEMOAT_AGENT_SOURCE/.test(line)).length,
      /^\s*if \[ "\$2" = npm \]; then set_env REEMOAT_AGENT_SOURCE npm "\$_env"; fi$/m.test(writeEnv),
      /^\s*' "\$CHECKOUT\/deploy\/lib\.sh" "\$CP" "\$AGENT_SOURCE"/m.test(writeEnv),
    ],
    [1, true, true],
  );
  // Only the call line binds the third argument to AGENT_CHANNEL, so it is pinned here (Q4.115).
  check("the bootstrap defaults the agent channel to latest", lineIn("bootstrap.sh", bootLines, "the agent-channel default", "AGENT_CHANNEL="), "AGENT_CHANNEL=latest");
  check(
    "and parse_flags takes --agent-channel, refusing any third spelling by name",
    [/--agent-channel\)/.test(parseFlags), /stable \| latest\) ;;/.test(parseFlags), parseFlags.includes('die "--agent-channel takes stable or latest, not $AGENT_CHANNEL"')],
    [true, true, true],
  );
  check(
    "usage documents the flag, both values, that it is claude's alone, and dates what it says about stable",
    [/--agent-channel <ch>/.test(bootFn("usage")), /`stable`/.test(bootFn("usage")), /`latest`/.test(bootFn("usage")), /Claude only/.test(bootFn("usage")), bootFn("usage").includes("2026-09-05")],
    [true, true, true, true, true],
  );
  check("install_agents passes it to the script as --channel, beside the source", bootFn("install_agents").includes('"$CHECKOUT/deploy/agents.sh" --source "$AGENT_SOURCE" --channel "$AGENT_CHANNEL"'), true);
  check(
    "and write_env_file writes it for the daemon only when it is stable, off the call line's third argument",
    [
      bootBody.filter((line) => /set_env REEMOAT_AGENT_CHANNEL/.test(line)).length,
      /^\s*if \[ "\$3" = stable \]; then set_env REEMOAT_AGENT_CHANNEL stable "\$_env"; fi$/m.test(writeEnv),
      /^\s*' "\$CHECKOUT\/deploy\/lib\.sh" "\$CP" "\$AGENT_SOURCE" "\$AGENT_CHANNEL"/m.test(writeEnv),
    ],
    [1, true, true],
  );

  const envBody = /sh -c '([\s\S]*?)' "\$CHECKOUT\/deploy\/lib\.sh"/.exec(writeEnv)?.[1];
  check("write_env_file's body can be lifted out of it", envBody !== undefined, true);
  const envHome = join(sandbox, "bootstrap-env-home");
  const writeEnvRun = (source: string, channel = "latest"): { run: Run; file: string } => {
    const file = join(envHome, `${source}-${channel}`, "daemon.env");
    const run = spawnSync("sh", ["-c", envBody ?? "false", join(deployDir, "lib.sh"), "https://cp.example", source, channel], {
      encoding: "utf8",
      env: { ...baseEnv, HOME: envHome, REEMOAT_ENV_FILE: file },
      input: "code-1",
    });
    return { run: { status: run.status ?? -1, out: run.stdout ?? "", err: run.stderr ?? "" }, file };
  };
  const valueIn = (file: string, key: string): string => sh(`file_value "${file}" ${key}`).out;
  const npmEnv = writeEnvRun("npm");
  check(
    "under npm it writes the control plane, the code and the source, and prints where",
    [
      npmEnv.run.status,
      npmEnv.run.out,
      valueIn(npmEnv.file, "REEMOAT_AUTH"),
      valueIn(npmEnv.file, "REEMOAT_CONTROL_PLANE"),
      valueIn(npmEnv.file, "REEMOAT_ENROLL_CODE"),
      valueIn(npmEnv.file, "REEMOAT_AGENT_SOURCE"),
      readFileSync(npmEnv.file, "utf8").split("\n").filter((line) => /^REEMOAT_AGENT_CHANNEL=/.test(line)),
    ],
    [0, npmEnv.file, "signed", "https://cp.example", "code-1", "npm", []],
  );
  check("into a directory and a file closed to everybody else", [statSync(dirname(npmEnv.file)).mode & 0o777, statSync(npmEnv.file).mode & 0o777], [0o700, 0o600]);
  const vendorEnv = writeEnvRun("vendor");
  check(
    "and under vendor the same file with no source line at all",
    [
      vendorEnv.run.status,
      valueIn(vendorEnv.file, "REEMOAT_CONTROL_PLANE"),
      valueIn(vendorEnv.file, "REEMOAT_AGENT_SOURCE"),
      readFileSync(vendorEnv.file, "utf8").split("\n").filter((line) => /^REEMOAT_AGENT_(SOURCE|CHANNEL)=/.test(line)),
    ],
    [0, "https://cp.example", "", []],
  );
  const stableEnv = writeEnvRun("vendor", "stable");
  check(
    "and a chosen stable is written as the one channel line, single-quoted",
    [
      stableEnv.run.status,
      valueIn(stableEnv.file, "REEMOAT_AGENT_CHANNEL"),
      readFileSync(stableEnv.file, "utf8").split("\n").filter((line) => /^REEMOAT_AGENT_CHANNEL=/.test(line)),
      readFileSync(stableEnv.file, "utf8").split("\n").filter((line) => /^REEMOAT_AGENT_SOURCE=/.test(line)),
    ],
    [0, "stable", ["REEMOAT_AGENT_CHANNEL='stable'"], []],
  );

  // install_node removes node's own files by name and never the toolchain directory, which also holds every npm-installed harness (Q4.114).
  const installNode = bootFn("install_node");
  const installNodeCode = installNode.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const removed = (/^\s*for _f in ([^;]*); do$/m.exec(installNodeCode)?.[1] ?? "").trim().split(/\s+/);
  check("install_node never removes the toolchain directory itself", /rm -rf "\$TOOLCHAIN"(?!\/)/.test(installNodeCode), false);
  check(
    "and removes node's own files by name, before unpacking over them",
    [
      ["bin/node", "bin/npm", "bin/npx", "bin/corepack", "lib/node_modules/npm", "lib/node_modules/corepack"].filter((one) => !removed.includes(one)),
      removed.filter((one) => ["bin", "lib", "lib/node_modules", ".", ""].includes(one)),
      /^\s*rm -rf "\$TOOLCHAIN\/\$_f"$/m.test(installNode),
      installNode.indexOf("for _f in") < installNode.indexOf("tar -xzf"),
    ],
    [[], [], true, true],
  );

  const installAgentsFn = bootFn("install_agents");
  // Comments skipped, so a prose line naming the script is not taken for the call.
  const installAgentsLines = installAgentsFn
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const agentsCall = installAgentsLines.find((line) => line.includes("deploy/agents.sh")) ?? "";
  check(
    "install_agents runs the script with the installed node's directory in front",
    agentsCall.trim().startsWith('( PATH="$(dirname -- "$NODE_BIN"):$PATH" "$CHECKOUT/deploy/agents.sh" --source "$AGENT_SOURCE" --channel "$AGENT_CHANNEL" $_only )'),
    true,
  );
  // Asserted as an early return before the call: a guard after it would still contain both strings.
  const guardAt = installAgentsLines.findIndex((line) => line.includes('[ -n "$INSTALL_AGENTS" ] ||'));
  const callAt = installAgentsLines.findIndex((line) => line.includes("deploy/agents.sh"));
  check(
    "and installs nothing at all unless somebody named a harness",
    [guardAt !== -1, guardAt < callAt, installAgentsFn.includes("press Install")],
    [true, true, true],
  );
  check(
    "each named harness is forwarded as --only, for the script to validate",
    installAgentsFn.includes('_only="$_only --only $_one"'),
    true,
  );

  check("the bootstrap remembers whether --agent-source was given, defaulting to not", lineIn("bootstrap.sh", bootLines, "the agent-source-given default", "AGENT_SOURCE_GIVEN="), "AGENT_SOURCE_GIVEN=0");
  const flagLines = parseFlags.split("\n").map((line) => line.trim());
  const sourceArm = flagLines.indexOf("--agent-source)");
  check(
    "parse_flags sets it as the arm's first act after taking the value",
    [sourceArm !== -1, flagLines[sourceArm + 1]?.startsWith('AGENT_SOURCE="${2:-}"; need_value "--agent-source"'), flagLines[sourceArm + 2]],
    [true, true, "AGENT_SOURCE_GIVEN=1"],
  );
  const existing = bootFn("existing_install").split("\n").map((line) => line.trim());
  const boundRead = existing.indexOf('[ -n "$_bound" ] || return 1');
  const flagRefused = existing.findIndex((line) => line.startsWith('[ "$AGENT_SOURCE_GIVEN" = 0 ] || die "already set up here, so --agent-source changes nothing.'));
  const nonTty = existing.findIndex((line) => line.startsWith('if [ "$TTY_OPEN" != 1 ]; then'));
  const menuAt = existing.findIndex((line) => line.includes('menu "Already joined'));
  check("existing_install refuses the flag on a machine that is already set up", flagRefused !== -1, true);
  check(
    "after the env file is read, so a fresh machine given the flag carries on, and before any menu or non-interactive exit",
    [boundRead !== -1 && boundRead < flagRefused, nonTty !== -1 && flagRefused < nonTty, menuAt !== -1 && flagRefused < menuAt],
    [true, true, true],
  );
  check(
    "naming where the setting lives now, and the script that would apply it today",
    [
      existing.slice(flagRefused, flagRefused + 3).join("\n").includes("REEMOAT_AGENT_SOURCE=$AGENT_SOURCE in $_env"),
      existing.slice(flagRefused, flagRefused + 3).join("\n").includes("deploy/agents.sh --source $AGENT_SOURCE"),
    ],
    [true, true],
  );
  check("the bootstrap remembers whether --agent-channel was given, defaulting to not", lineIn("bootstrap.sh", bootLines, "the agent-channel-given default", "AGENT_CHANNEL_GIVEN="), "AGENT_CHANNEL_GIVEN=0");
  const channelArm = flagLines.indexOf("--agent-channel)");
  check(
    "parse_flags sets it as the arm's first act after taking the value",
    [channelArm !== -1, flagLines[channelArm + 1]?.startsWith('AGENT_CHANNEL="${2:-}"; need_value "--agent-channel"'), flagLines[channelArm + 2]],
    [true, true, "AGENT_CHANNEL_GIVEN=1"],
  );
  const channelRefused = existing.findIndex((line) => line.startsWith('[ "$AGENT_CHANNEL_GIVEN" = 0 ] || die "already set up here, so --agent-channel changes nothing.'));
  check(
    "existing_install refuses the channel flag too, beside the source's refusal and before any menu or non-interactive exit",
    [channelRefused !== -1, channelRefused > flagRefused, nonTty !== -1 && channelRefused < nonTty, menuAt !== -1 && channelRefused < menuAt],
    [true, true, true, true],
  );
  const channelRefusal = existing.slice(channelRefused, existing.findIndex((line, i) => i >= channelRefused && /"$/.test(line)) + 1).join("\n");
  check(
    "naming where the channel lives now, the restart that makes the daemon read it, and the script run as an addition rather than an alternative",
    [
      channelRefusal.includes("REEMOAT_AGENT_CHANNEL=$AGENT_CHANNEL in $_env"),
      channelRefusal.includes("restart the daemon"),
      channelRefusal.includes("also run $CHECKOUT/deploy/agents.sh --channel $AGENT_CHANNEL"),
      /\bor run\b/.test(channelRefusal),
    ],
    [true, true, true, false],
  );
  check("and names no vendor of its own", /https?:\/\/(claude\.ai|chatgpt\.com|opencode\.ai)|registry\.npmjs/.test(boot), false);
}

{
  const cpExample = readFileSync(join(repoRoot, "packages/control-plane/.env.example"), "utf8");
  const installer = readFileSync(join(repoRoot, "deploy/install.sh"), "utf8");
  const KEY = "REEMOAT_CP_TRUSTED_PROXY_HOPS";

  check("the control plane's example documents the trusted-proxy setting", cpExample.includes(KEY), true);
  check(
    "and shows the safe default rather than only naming the key",
    new RegExp(`^#\\s*${KEY}=0$`, "m").test(cpExample),
    true,
  );
  check("the control-plane wizard writes it", new RegExp(`set_env ${KEY} `).test(installer), true);

  // Env-only values outside SETTING_KEYS, which the sweep above cannot reach.
  for (const envOnly of [
    "REEMOAT_CP_PLUGIN_CATALOGUE_URL",
    "REEMOAT_CP_APP_DOWNLOAD_URL",
    "REEMOAT_CP_LEGAL_DOCUMENTS",
    "REEMOAT_CP_INSTALL",
  ]) {
    check(
      `the example documents ${envOnly} as a commented assignment`,
      new RegExp(`^#\\s*${envOnly}=`, "m").test(cpExample),
      true,
    );
    check(
      `and ${envOnly} is read from the environment rather than the settings table`,
      new RegExp(`process\\.env\\["${envOnly}"\\]`).test(
        readFileSync(join(repoRoot, "packages/control-plane/src/main.ts"), "utf8"),
      ),
      true,
    );
  }
  // Read off main.ts by regex: it is a process entry with side effects and cannot be imported.
  {
    const mainTs = readFileSync(join(repoRoot, "packages/control-plane/src/main.ts"), "utf8");
    const spellings = (name: string, sense: "Off" | "Default"): string[] => {
      const found = new RegExp(`const ${name}${sense} =([^;]+);`).exec(mainTs)?.[1] ?? "";
      return [...found.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").sort();
    };
    check("the installer switch spells off three ways", spellings("install", "Off"), ["0", "false", "no"]);
    check(
      "and still has a default for an affirmative to mean",
      spellings("install", "Default"),
      ["1", "true", "yes"],
    );
    // Matches the read rather than the name, so prose about the deleted variable does not fail it.
    check("and nothing reads a variable naming a web bundle", /process\.env\["REEMOAT_CP_WEB"\]/.test(mainTs), false);
    // The deleted machine-offer variable: never read by name, still on the retirement list, gone from the example (Q1.650).
    check(
      "and the machine offer is not read by name any more; only the retirement list names it",
      /process\.env\["REEMOAT_CP_MACHINES_OFFER_URL"\]/.test(mainTs),
      false,
    );
    check(
      "but an env file still setting it is warned about",
      /const RETIRED_ENV[^=]*=\s*\{[^}]*\bREEMOAT_CP_MACHINES_OFFER_URL:/.test(mainTs),
      true,
    );
    check(
      "and the example no longer documents it as a setting",
      /^#\s*REEMOAT_CP_MACHINES_OFFER_URL=/m.test(cpExample),
      false,
    );
  }

  check("from an answer rather than a literal", new RegExp(`set_env ${KEY} "\\$`).test(installer), true);

  const relays = readFileSync(join(repoRoot, "deploy/RELAYS.md"), "utf8");
  const readme = readFileSync(join(repoRoot, "deploy/README.md"), "utf8");
  check("the multi-relay document names what enrollment bakes", [
    // Bounded: the singular key is a prefix of the plural one.
    /REEMOAT_CP_RELAY_URL(?![A-Z_])/.test(relays),
    relays.includes("REEMOAT_CP_ISSUER"),
    relays.includes("identity.relay_url"),
  ], [true, true, true]);
  check("and the routing key it exists to explain", relays.includes("REEMOAT_CP_RELAY_URLS"), true);
  check("which the example documents too", cpExample.includes("REEMOAT_CP_RELAY_URLS"), true);
  check("and the deploy README points at it", readme.includes("RELAYS.md"), true);
}

process.stdout.write("\nthe PATH a supervised process is given\n");

const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

check("with no tools at all it is the system directories, in order", sh("runtime_path").out, SYSTEM_PATH);
check(
  "a tool already covered by them adds nothing",
  sh('runtime_path /usr/bin/env 2>/dev/null').out,
  SYSTEM_PATH,
);
check(
  "and two tools from one directory do not name it twice",
  sh('runtime_path /usr/bin/env /usr/bin/sed 2>/dev/null').out,
  SYSTEM_PATH,
);

{
  // A tool whose appended directory re-resolves to a different binary; sh guarantees a system-directory copy exists.
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sh"), "#!/bin/sh\n", { mode: 0o755 });
  const run = sh('runtime_path "$B/sh"', { B: bin });
  check("a tool that re-resolves elsewhere goes in front instead", run.out.startsWith(`${bin}:`), true);
  check("and the system directories keep their order behind it", run.out, `${bin}:${SYSTEM_PATH}`);
  check("and it says out loud that it did so", run.err.includes("goes ahead of the system directories"), true);

  // Modes are set explicitly so the ambient umask cannot decide what this measures.
  chmodSync(bin, 0o755);
  const tidy = sh('runtime_path "$B/sh"', { B: bin });
  check("a directory only its owner can write draws no warning", /writable by more than its owner/.test(tidy.err), false);

  chmodSync(bin, 0o775);
  const groupWritable = sh('runtime_path "$B/sh"', { B: bin });
  check("a group-writable one is called out", /writable by more than its owner/.test(groupWritable.err), true);
  check("with the mode it read, so the reader can check the claim", /drwxrwxr-x/.test(groupWritable.err), true);
  check("and it names what that costs rather than only the fact", groupWritable.err.includes('spawns bare "git"'), true);

  chmodSync(bin, 0o757);
  check(
    "world-writable is the other arm of the same pattern",
    /writable by more than its owner/.test(sh('runtime_path "$B/sh"', { B: bin }).err),
    true,
  );

  chmodSync(bin, 0o775);
  check("but it is still a warning, so the PATH is still printed", sh('runtime_path "$B/sh"', { B: bin }).out, `${bin}:${SYSTEM_PATH}`);
  chmodSync(bin, 0o755);
}

check(
  "an explicit override wins outright",
  sh("runtime_path /usr/bin/env", { REEMOAT_UNIT_PATH: "/only/this" }).out,
  "/only/this",
);

process.stdout.write("\nescaping a value into a template\n");

check("sed's replacement metacharacters are escaped", sh(`esc_sed 'a&b|c\\d'`).out, "a\\&b\\|c\\\\d");
check("an ampersand becomes an entity", sh("esc_xml 'a&b'").out, "a&amp;b");
check("and the angle brackets too", sh("esc_xml '<x>'").out, "&lt;x&gt;");
// Ampersand first, or the entities the later rules introduce are escaped again.
check("and the ordering does not double-escape what it just introduced", sh("esc_xml '&<>'").out, "&amp;&lt;&gt;");
check(
  "XML escaping happens only where the template is XML",
  [sh("INIT_SYSTEM=launchd; subst_value 'a&b'").out, sh("INIT_SYSTEM=systemd; subst_value 'a&b'").out],
  ["a\\&amp;b", "a\\&b"],
);

process.stdout.write("\nrendering a unit\n");

for (const init of ["launchd", "systemd"] as const) {
  const target = join(sandbox, `out.${init}`);
  const run = sh(`INIT_SYSTEM=${init}; render_unit daemon "$T" 2>/dev/null`, { T: target });
  check(`${init}: rendering succeeds`, run.status, 0);

  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  check(`${init}: no placeholder survives`, text.match(/@[A-Z_]+@/g), null);
  check(`${init}: it runs the daemon's wrapper`, text.includes(join(deployDir, "run-daemon.sh")), true);
  check(`${init}: with the repository as its working directory`, text.includes(repoRoot), true);
  check(`${init}: and a PATH resolved rather than written down`, text.includes(SYSTEM_PATH), true);
}

{
  const plist = readFileSync(join(sandbox, "out.launchd"), "utf8");

  check("a plist gets the XML-escaped home", plist.includes("home a&amp;b&lt;c|d"), true);
  check("and never the raw characters that would break the parse", /home a&b<c/.test(plist), false);
}

{
  const plist = readFileSync(join(sandbox, "out.launchd"), "utf8");
  const service = readFileSync(join(sandbox, "out.systemd"), "utf8");

  check("a launchd job is told which environment file to read", plist.includes("<key>REEMOAT_ENV_FILE</key>"), true);
  check("with the path entity-encoded like every other one in it", plist.includes("home a&amp;b&lt;c|d/.reemoat/daemon.env"), true);

  check(
    "and a systemd unit gets it quoted, because the path may contain a space",
    service.includes(`Environment="REEMOAT_ENV_FILE=${home}/.reemoat/daemon.env"`),
    true,
  );

  // The fixture path is one no prose would write: a plist comment is rendered into the plist.
  const packaged = "/etc/reemoat/deploycheck-packaged.env";
  for (const init of ["launchd", "systemd"] as const) {
    const target = join(sandbox, `out.envfile.${init}`);
    const run = sh(`INIT_SYSTEM=${init}; render_unit daemon "$T" 2>/dev/null`, { T: target, REEMOAT_ENV_FILE: packaged });
    const text = existsSync(target) ? readFileSync(target, "utf8") : "";
    check(`${init}: an overridden environment file reaches the rendered unit`, run.status === 0 && text.includes(packaged), true);
    check(`${init}: and the default the wrapper would fall back to is not in it`, text.includes("/.reemoat/daemon.env"), false);
  }
}

{
  const nasty = "/opt/a&b/bin:/opt/c|d/bin:/usr/bin";
  const target = join(sandbox, "out.nasty");
  const run = sh(`INIT_SYSTEM=systemd; render_unit daemon "$T" 2>/dev/null`, {
    T: target,
    REEMOAT_UNIT_PATH: nasty,
  });
  const service = existsSync(target) ? readFileSync(target, "utf8") : "";
  check("a systemd unit renders with a PATH holding sed's own characters", run.status, 0);
  check("and the value arrives literally, unescaped and unentitied", service.includes(`Environment=PATH=${nasty}`), true);
  check("with no entity where the template is not XML", service.includes("&amp;"), false);
}

{
  const run = sh('INIT_SYSTEM=launchd; render_unit control-plane "$T"', { T: join(sandbox, "never") });
  check("the control plane has no unit to render", run.status, 2);
  check("and nothing was written where one was asked for", existsSync(join(sandbox, "never")), false);
  check("with the remedy naming the wrapper that does start it", run.err.includes("compose.sh up -d"), true);
}

{
  const run = sh('INIT_SYSTEM=none; render_unit daemon "$T"', { T: join(sandbox, "neither") });
  check("a host with no supervisor is refused rather than guessed at", run.status, 2);
  check("and told about the wrapper it can run from its own", run.err.includes("run-daemon.sh"), true);
}

process.stdout.write("\nwhere a service answers\n");

{
  const svcEnv = join(home, ".reemoat", "daemon.env");
  const cpSvcEnv = join(home, ".reemoat", "control-plane.env");
  const origin = (svc: string): string => sh(`service_origin ${svc}`).out;
  const probe = (svc: string): string => sh(`health_probe_target ${svc}`).out;

  check("a service with no environment file has no origin", origin("daemon"), "");
  check("and the probe says which file it wanted rather than failing", probe("daemon").startsWith("skip no environment file at "), true);
  check("naming the path it looked in", probe("daemon").includes(svcEnv), true);

  writeFileSync(svcEnv, "REEMOAT_HOST=127.0.0.1\nREEMOAT_PORT=7887\n");
  check("an ordinary daemon answers on what it bound", origin("daemon"), "http://127.0.0.1:7887");
  check("and the probe builds /health onto it", probe("daemon"), "ok http://127.0.0.1:7887/health");

  writeFileSync(svcEnv, "REEMOAT_HOST=0.0.0.0\nREEMOAT_PORT=7887\n");
  check("a wildcard bind is probed on loopback", origin("daemon"), "http://127.0.0.1:7887");
  writeFileSync(svcEnv, "REEMOAT_HOST=::\nREEMOAT_PORT=7887\n");
  check("and the v6 wildcard on the v6 loopback, in brackets", origin("daemon"), "http://[::1]:7887");
  writeFileSync(svcEnv, "REEMOAT_HOST=\nREEMOAT_PORT=7887\n");
  check("an empty host is a wildcard too, not a hostname", origin("daemon"), "http://127.0.0.1:7887");

  writeFileSync(svcEnv, "REEMOAT_HOST=127.0.0.1\nREEMOAT_PORT=0\n");
  check("a kernel-assigned port yields no origin to probe", origin("daemon"), "");
  check("and the probe skips rather than failing the deploy", probe("daemon"), "skip daemon listens on a kernel-assigned port");

  writeFileSync(svcEnv, "REEMOAT_TOKEN=x\n");
  check("a file that names neither falls back to the documented pair", origin("daemon"), "http://127.0.0.1:7887");

  writeFileSync(cpSvcEnv, "REEMOAT_CP_PUBLISH=127.0.0.1\nREEMOAT_CP_PORT=7888\n");
  check("the control plane answers on what it publishes", origin("control-plane"), "http://127.0.0.1:7888");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_HOST=0.0.0.0\n");
  check("and reads its own names, not the daemon's", origin("control-plane"), "http://127.0.0.1:7888");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_PUBLISH=0.0.0.0\nREEMOAT_CP_PORT=7888\n");
  check("a published wildcard is loopback here too", origin("control-plane"), "http://127.0.0.1:7888");

  writeFileSync(cpSvcEnv, "REEMOAT_CP_RELAY_PUBLISH=127.0.0.1\nREEMOAT_CP_RELAY_PORT=7889\n");
  check("the relay answers on its own published pair", origin("relay"), "http://127.0.0.1:7889");
  check("and is probed on a path of its own, never /health", probe("relay"), "ok http://127.0.0.1:7889/__relay/health");
  check("while the control plane beside it keeps /health", probe("control-plane"), "ok http://127.0.0.1:7888/health");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_ISSUER=x\n");
  check("its defaults are the wide ones, collapsed to loopback for a local probe", origin("relay"), "http://127.0.0.1:7889");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_RELAY_PUBLISH=::\nREEMOAT_CP_RELAY_PORT=7889\n");
  check("and the v6 wildcard is bracketed here too", origin("relay"), "http://[::1]:7889");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_RELAY_PORT=0\n");
  check("a kernel-assigned relay port skips rather than failing the deploy", probe("relay"), "skip relay listens on a kernel-assigned port");

  writeFileSync(svcEnv, "REEMOAT_TOKEN=from-the-env-file\n");
  check("env_value reads a service's own file without being told where it is", sh("env_value daemon REEMOAT_TOKEN").out, "from-the-env-file");
  // Single-quoted so the substitution reaches env_value as text instead of being expanded by this harness.
  check("and a key that is not a key is still refused through the wrapper", sh(`env_value daemon 'A:-$(touch $SANDBOX/EVALED2)'`, { SANDBOX: sandbox }).status, 2);
  check("with the eval still never running", existsSync(join(sandbox, "EVALED2")), false);
}

process.stdout.write("\nfinding the template and the tools\n");

check(
  "each init system has its own template, in the repository",
  [sh("INIT_SYSTEM=launchd; unit_template").out, sh("INIT_SYSTEM=systemd; unit_template").out],
  [join(deployDir, "launchd/reemoat.plist.in"), join(deployDir, "systemd/reemoat.service.in")],
);
check("and both really exist, so render_unit has something to read", [
  existsSync(join(deployDir, "launchd/reemoat.plist.in")),
  existsSync(join(deployDir, "systemd/reemoat.service.in")),
], [true, true]);

{
  // Through printf on both sides: command -v ends its line with a newline.
  check("a real program resolves to an absolute path", sh("resolve_bin sh whatever").out, sh('printf "%s" "$(command -v sh)"').out);
  const missing = sh("resolve_bin definitely-not-a-real-program-xyz whatever");
  check("one that is not there is a refusal", missing.status, 2);
  check("naming the thing that wanted it, not just the thing missing", missing.err.includes("whatever"), true);
  check("and printing nothing to be substituted into a template", missing.out, "");
}

process.stdout.write("\na host with neither supervisor\n");

for (const fn of ["unit_label daemon", "unit_target daemon", "log_dir", "unit_template"] as const) {
  const run = sh(`INIT_SYSTEM=none; printf "[%s]" "$(${fn})"`);
  check(`${fn.split(" ")[0]} derives nothing rather than guessing`, run.out, "[]");
  check(`${fn.split(" ")[0]} does not fail its caller for it`, run.status, 0);
}
check("subst_value derives nothing too, which is the shape the refusals exist for", sh("INIT_SYSTEM=none; printf '[%s]' \"$(subst_value 'a&b')\"").out, "[]");

process.stdout.write("\nreading one field of a JSON answer\n");

const jsonCases: Array<[string, string, string, string]> = [
  ["a present field", '{"ok":true,"instanceId":"i_1"}', "instanceId", "i_1"],
  ["a number is stringified", '{"uptimeMs":42}', "uptimeMs", "42"],
  ["a boolean too", '{"ok":true}', "ok", "true"],
  ["an absent field is empty", '{"ok":true}', "instanceId", ""],
  ["and so is an explicit null", '{"instanceId":null}', "instanceId", ""],
  ["malformed JSON is empty rather than a crash", "not json at all", "ok", ""],
  ["and so is nothing at all", "", "ok", ""],
];

for (const [name, body, field, want] of jsonCases) {
  const run = sh(`printf '%s' "$BODY" | json_field "$FIELD"`, { BODY: body, FIELD: field });
  check(name, run.out, want);
  check(`${name} — without failing the caller`, run.status, 0);
}

const installLines = readFileSync(join(deployDir, "install.sh"), "utf8").split("\n");
const deployLines = readFileSync(join(deployDir, "deploy.sh"), "utf8").split("\n");
const mainSource = readFileSync(join(repoRoot, "packages/control-plane/src/main.ts"), "utf8");

/** One line of a shell file, found by prefix; a miss counts as a failure and returns a failing command. */
function lineIn(file: string, lines: readonly string[], what: string, startsWith: string): string {
  const found = lines.find((line) => line.trim().startsWith(startsWith));
  if (found === undefined) {
    failures += 1;
    process.stdout.write(`  FAIL  ${file} no longer holds ${what}\n        looked for a line starting  ${startsWith}\n`);
    return "false # not found";
  }
  return found.trim();
}

/** Lines from startsWith to the next line at the same indentation equal to endsWith; indentation stands in for brace matching. */
function blockIn(file: string, lines: readonly string[], what: string, startsWith: string, endsWith: string): string {
  const start = lines.findIndex((line) => line.trim().startsWith(startsWith));
  const indent = start === -1 ? "" : (/^\s*/.exec(lines[start] as string)?.[0] ?? "");
  const end = lines.findIndex((line, i) => i > start && line === `${indent}${endsWith}`);
  if (start === -1 || end === -1) {
    failures += 1;
    process.stdout.write(`  FAIL  ${file} no longer holds ${what}\n        looked for  ${startsWith} … ${endsWith}\n`);
    return "false # not found";
  }
  return lines.slice(start, end + 1).join("\n");
}

/** One case arm, from its label to the closing ;; two columns deeper; empty on a miss. */
function armOf(block: string, label: string): string {
  const lines = block.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${label})`);
  if (start === -1) return "";
  const closer = `${" ".repeat((/^\s*/.exec(lines[start] ?? "")?.[0].length ?? 0) + 2)};;`;
  const end = lines.findIndex((line, i) => i > start && line === closer);
  return end === -1 ? "" : lines.slice(start, end + 1).join("\n");
}

const installLine = (what: string, startsWith: string): string => lineIn("install.sh", installLines, what, startsWith);
const installBlock = (what: string, startsWith: string, endsWith: string): string =>
  blockIn("install.sh", installLines, what, startsWith, endsWith);
const deployBlock = (what: string, startsWith: string, endsWith: string): string =>
  blockIn("deploy.sh", deployLines, what, startsWith, endsWith);

/** What a rendered bootstrap line carries where `main.ts` interpolates. */
const BOOTSTRAP_KEY = "rk_ZGVwbG95Y2hlY2sta2V5";
const BOOTSTRAP_PASSWORD = "ZGVwbG95Y2hlY2stcGFzc3dvcmQ";

/** A line main.ts prints when it bootstraps an admin, read from its source with the interpolations filled in. */
function printedLine(what: string, marker: string, values: Record<string, string> = {}): string {
  const bodies = [...mainSource.matchAll(/console\.log\((?:`([^`]*)`|"([^"]*)")\)/g)].map((m) => m[1] ?? m[2] ?? "");
  const body = bodies.find((line) => line.includes(marker));
  if (body === undefined) {
    failures += 1;
    process.stdout.write(`  FAIL  main.ts no longer prints ${what}\n        looked for  ${marker}\n`);
    return `<${what} is gone>`;
  }
  const filled: Record<string, string> = {
    "key.key": BOOTSTRAP_KEY,
    password: BOOTSTRAP_PASSWORD,
    name: "admin",
    userId: "u_deploycheck",
    ...values,
  };
  return body.replace(/\$\{([^}]+)\}/g, (_whole, expr: string) => filled[expr] ?? `<${expr}>`);
}

const keyLine = printedLine("the admin's API key", "API key: ");
const passwordLine = printedLine("the generated admin password", "admin password: ");
const passwordSourceLine = printedLine("where a supplied password came from", "admin password source: ");
const shownOnceLine = printedLine("the shown-once notice", "Shown once");

/** The block as compose logs print it; the installer's leading-space anchor would not survive a journal prefix. */
function bootstrapLog(name: string, ...body: string[]): string {
  return ["", printedLine("the bootstrapped-user line", "bootstrapped admin user", { name }), ...body, shownOnceLine, ""].join("\n");
}

const scrapeKey = installLine("the API-key scrape", "_key=$(printf");
const scrapePw = installLine("the admin-password scrape", "_pw=$(printf");
const scrapePwSrc = installLine("the password-source scrape", "_pw_src=$(printf");

/** All three of the installer's scrapes, against one log. */
function scrape(log: string): { key: string; pw: string; src: string } {
  const run = sh(
    ["_log=$LOGFIXTURE", scrapeKey, scrapePw, scrapePwSrc, 'printf "%s\\n%s\\n%s" "$_key" "$_pw" "$_pw_src"'].join("\n"),
    { LOGFIXTURE: log },
  );
  const [key = "", pw = "", src = ""] = run.out.split("\n");
  return { key, pw, src };
}

process.stdout.write("\nscraping a one-time credential out of a log\n");

{
  const generated = scrape(bootstrapLog("admin", keyLine, passwordLine));
  check("the generated password is scraped exactly", generated.pw, BOOTSTRAP_PASSWORD);
  check("and the key off the line above it", generated.key, BOOTSTRAP_KEY);
  check("with nothing claiming the password came from the environment", generated.src, "");

  const supplied = scrape(bootstrapLog("admin", keyLine, passwordSourceLine));
  check("a supplied password yields no scraped password at all", supplied.pw, "");
  check("the source marker is what says so instead", supplied.src, "1");
  check("and the key is still read on that arm", supplied.key, BOOTSTRAP_KEY);
  check("main.ts's second arm no longer carries the marker that means a value follows", /^ *admin password: /.test(passwordSourceLine), false);

  const historic = scrape(bootstrapLog("admin", keyLine, "  admin password: taken from REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD (not printed)"));
  check("a marker line carrying a sentence rather than a value scrapes to nothing", historic.pw, "");
  check("and never to the last word of that sentence", historic.pw === "printed)", false);

  // The hostile line goes last: both scrapes end in tail -1, so only a later line can beat an anchor.
  const hostileName = "x API key: rk_evil admin password: not-a-password";
  const hostile = scrape(
    ["", keyLine, passwordLine, shownOnceLine, printedLine("the bootstrapped-user line", "bootstrapped admin user", { name: hostileName }), ""].join("\n"),
  );
  check("a name carrying both markers feeds neither scrape, wherever it lands", [hostile.key, hostile.pw], [BOOTSTRAP_KEY, BOOTSTRAP_PASSWORD]);
  check("and the source marker is not fooled by it either", hostile.src, "");
}

process.stdout.write("\nwaiting for the second line to arrive\n");

const breakLine = installLine("the capture loop's exit condition", 'if [ -n "$_key" ]');

// `for` wraps the line because `break` outside a loop is not a statement.
function loopDecision(key: string, pw: string, src: string): string {
  return sh(
    ['_key="$K"; _pw="$P"; _pw_src="$S"', "for _once in 1; do", breakLine, "  printf keep-waiting", "  exit 0", "done", "printf broke"].join("\n"),
    { K: key, P: pw, S: src },
  ).out;
}

check("both lines present is the ordinary exit", loopDecision(BOOTSTRAP_KEY, BOOTSTRAP_PASSWORD, ""), "broke");
check("a key with no password yet keeps waiting", loopDecision(BOOTSTRAP_KEY, "", ""), "keep-waiting");
check("a key beside the source marker is enough, because no password is coming", loopDecision(BOOTSTRAP_KEY, "", "1"), "broke");
check("a password with no key yet keeps waiting too", loopDecision("", BOOTSTRAP_PASSWORD, ""), "keep-waiting");
check("and an empty log waits", loopDecision("", "", ""), "keep-waiting");

process.stdout.write("\nreporting a credential, or its absence\n");

const reportBlock = installBlock("the three-outcome password report", 'if [ -n "$_pw" ]; then', "fi");

function report(pw: string, src: string): string {
  return sh(
    ['_pw="$P"; _pw_src="$S"; _cp_ui="https://cp.example"; _admin_name=admin; ENV_FILE=/dev/null', reportBlock].join("\n"),
    { P: pw, S: src },
  ).out;
}

check("a scraped password is printed under the marker", report(BOOTSTRAP_PASSWORD, "").includes(`admin password: ${BOOTSTRAP_PASSWORD}`), true);

{
  const supplied = report("", "1");
  check("a supplied password says where it came from", supplied.includes("admin password source:"), true);
  check("without writing the marker that promises a value", supplied.includes("admin password: "), false);

  const lost = report("", "");
  check("a password that never arrived is never printed as an empty one", lost.includes("admin password: "), false);
  check("it says the line did not appear", /did not appear/.test(lost), true);
  check("and names a way back that still exists", /Settings → Server settings|reset link/.test(lost), true);
  check("and names neither deleted command", /admin passwd|admin key/.test(lost), false);
}

process.stdout.write("\ncreating the first person\n");

{
  const run = sh(
    [
      'cpctl() { printf "%s" "$FIXTURE"; }',
      "_person=alice",
      installLine("the daemon path's adduser call", '_created=$(cpctl admin adduser "$_person" --json)'),
      installLine("the id it reads out of that response", "_owner=$(printf"),
      installLine("the one-time password beside it", "_opw=$(printf"),
      'printf "%s|%s" "$_owner" "$_opw"',
    ].join("\n"),
    { FIXTURE: '{"id":"u_7","password":"kZ3-one-time"}' },
  );
  check("the daemon wizard keeps both the id and the one-time password", run.out, "u_7|kZ3-one-time");

  // The fixture still carries apiKey on purpose: the installer must ignore a field it does not read.
  const two = sh(
    [
      '_created="$FIXTURE"',
      installLine("the id of the first person", "_uid=$(printf"),
      installLine("their one-time password", "_upw=$(printf"),
      'printf "%s|%s" "$_uid" "$_upw"',
    ].join("\n"),
    { FIXTURE: '{"id":"u_9","password":"pw-9","apiKey":"rk_9"}' },
  );
  check("and the control plane's block keeps both of its fields", two.out, "u_9|pw-9");

  check(
    "and it no longer reads a field the route cannot return",
    installLines.some((line) => line.includes("json_field apiKey")),
    false,
  );
  check(
    "nor prints the variable that held it",
    installLines.some((line) => line.includes("_akey")),
    false,
  );

  const piped = installLines.filter(
    (line) => !line.trim().startsWith("#") && /cpctl admin adduser.*\|\s*json_field/.test(line),
  );
  check("and no adduser response anywhere is read through a pipe that consumes it", piped, []);
}

process.stdout.write("\nthe URL daemons will dial\n");

{
  const relayCase = installBlock("the relay URL's default", "_rurl_host=$_rhost", "esac");
  const relayPick = installBlock("the default it settles on", "_rurl_name=$(host_name)", "fi");
  const relayAsk = installLine("the prompt that offers it", '_rurl=$(ask "URL daemons will dial"');

  // `exec </dev/null` makes `ask` return its default instead of blocking; `host_name` and `lan_address` are stubbed.
  const relayDefault = (rhost: string, host: string, lan: string, name = ""): string =>
    sh(
      [
        `lan_address() { printf '%s' "$LAN"; }`,
        `host_name() { printf '%s' "$NAME"; }`,
        '_rhost="$RHOST"; _host="$HOST"; _rport=7889',
        relayCase,
        relayPick,
        "exec </dev/null",
        relayAsk,
        'printf "%s" "$_rurl"',
      ].join("\n"),
      { RHOST: rhost, HOST: host, LAN: lan, NAME: name },
    ).out;

  check(
    "a host with a name is offered that name, over https",
    relayDefault("203.0.113.7", "127.0.0.1", "192.168.1.5", "relay.example.com"),
    "https://relay.example.com",
  );
  check(
    "and the name wins over every address the interview collected",
    relayDefault("0.0.0.0", "0.0.0.0", "192.168.1.5", "cp.example.com"),
    "https://cp.example.com",
  );

  check(
    "a host with no name still gets the address it gave for the relay",
    relayDefault("203.0.113.7", "127.0.0.1", "192.168.1.5"),
    "http://203.0.113.7:7889",
  );
  check(
    "including when that address is loopback and the API is the wide one",
    relayDefault("127.0.0.1", "0.0.0.0", "192.168.1.5"),
    "http://127.0.0.1:7889",
  );

  for (const wildcard of ["0.0.0.0", "*", "::"] as const) {
    check(
      `a relay bound to ${wildcard} falls back to the default-route address`,
      relayDefault(wildcard, "127.0.0.1", "192.168.1.5"),
      "http://192.168.1.5:7889",
    );
  }
  check(
    "and behind that the address already confirmed for the API",
    relayDefault("0.0.0.0", "203.0.113.9", ""),
    "http://203.0.113.9:7889",
  );

  const hostNameWith = (answer: string): string =>
    sh(`hostname() { printf '%s\\n' "$ANSWER"; }\nhost_name`, { ANSWER: answer }).out;
  check("a dotted name is a name", hostNameWith("relay.example.com"), "relay.example.com");
  check("a bare label is not", hostNameWith("ubuntu"), "");
  check("and neither is mDNS", hostNameWith("laptop.local"), "");
  check("nor is nothing at all", hostNameWith(""), "");

  const warned = installLines.filter((line) => line.includes("every machine in the fleet, by hand"));
  check("the prompt says what changing it later costs", warned.length, 1);

  const unassigned = installLines.filter((line) => !line.trim().startsWith("#") && /\$\{?_lan\b/.test(line));
  check("and no line builds a default out of a variable nothing assigns", unassigned, []);
}

process.stdout.write("\nwhat the relay is made of\n");

{
  const deployScript = readFileSync(join(deployDir, "deploy.sh"), "utf8");
  const assigned = /^RELAY_INPUTS='([^']*)'$/m.exec(deployScript);
  check("deploy.sh assigns RELAY_INPUTS as a single-quoted literal", assigned !== null, true);

  const pattern = new RegExp(assigned?.[1] ?? "(?!)");

  const entry = join(repoRoot, "packages/control-plane/src/relay/main.ts");
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
      const specifier = match[1] as string;
      const resolved = join(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(resolved)) queue.push(realpathSync(resolved));
    }
  }

  const reached = [...seen]
    .map((file) => file.slice(realpathSync(repoRoot).length + 1))
    .sort();
  check("the relay entry reaches more than itself, so the walk really walked", reached.length > 5, true);
  check("and it reaches the root src/ files the image copies by name", reached.includes("src/relay/protocol.ts"), true);

  const uncovered = reached.filter((file) => !pattern.test(file));
  check("every file the relay is built from is an input that recreates it", uncovered, []);

  check("the schema is an input even though nothing imports it", pattern.test("packages/control-plane/src/schema.sql"), true);
  check("and so are the manifests that decide what runs it", [
    pattern.test("package.json"),
    pattern.test("pnpm-lock.yaml"),
  ], [true, true]);

  check("but a web-only change is not", [
    pattern.test("packages/web/src/ui/Composer.tsx"),
    pattern.test("packages/web/src/store.ts"),
  ], [false, false]);
  check("nor a route or a template on the API", [
    pattern.test("packages/control-plane/src/app.ts"),
    pattern.test("packages/control-plane/src/mail/templates.ts"),
  ], [false, false]);
  check("but a settings change now does, because the relay reads one", [
    pattern.test("packages/control-plane/src/settings.ts"),
    pattern.test("packages/control-plane/src/quota.ts"),
  ], [true, true]);
  check("nor anything that is only the daemon's", [
    pattern.test("src/session.ts"),
    pattern.test("src/registry.ts"),
    pattern.test("scripts/daemon.ts"),
  ], [false, false, false]);
}

process.stdout.write("\nwhat a deploy says a restart will cost\n");

{
  const announce = deployBlock("the restart announcement", "for svc in $act_list; do", "done");
  const services = sh('printf "%s" "$SERVICES"').out.trim().split(/\s+/);
  check("SERVICES is the three this file knows about", services, ["daemon", "control-plane", "relay"]);

  const announced = (list: string): string[] =>
    sh(`act_list=${JSON.stringify(list)}\n${announce}`)
      .out.split("\n")
      .filter((line) => line.length > 0);

  check(
    "every service announces something",
    services.map((svc) => announced(svc).length > 0),
    services.map(() => true),
  );
  check(
    "and each names the service it is about",
    services.map((svc) => (announced(svc)[0] ?? "").startsWith(`restart: ${svc} `)),
    services.map(() => true),
  );
  check("so no two of them say the same thing", new Set(services.map((svc) => announced(svc)[0])).size, services.length);

  check("and a name that is no service announces nothing at all", announced("nonesuch"), []);

  const saysTunnelsDrop = (svc: string): boolean => /\bdrops?\b/i.test(announced(svc).join(" "));
  check("the relay's line is the one that says tunnels drop", saysTunnelsDrop("relay"), true);
  check("and the control plane's does not, because after the split it does not", saysTunnelsDrop("control-plane"), false);
}

process.stdout.write("\nwhat a deploy does to the agents\n");

{
  const daemonArm = armOf(deployBlock("the per-service case", 'case "$svc" in', "esac"), "daemon");
  check("deploy.sh has a daemon arm", daemonArm.length > 0, true);
  const armLines = daemonArm
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const envAt = armLines.indexOf("_daemon_env=$(env_file daemon)");
  const readsOff = armLines.indexOf(`_agent_updates=$(file_value "$_daemon_env" REEMOAT_AGENT_UPDATES | tr '[:upper:]' '[:lower:]')`);
  const offArm = armLines.indexOf("off | 0 | false | no | never)");
  const readsSource = armLines.indexOf(`_agent_source=$(file_value "$_daemon_env" REEMOAT_AGENT_SOURCE | tr '[:upper:]' '[:lower:]')`);
  const defaults = armLines.indexOf('[ "$_agent_source" = npm ] || _agent_source=vendor');
  const readsChannel = armLines.indexOf(`_agent_channel=$(file_value "$_daemon_env" REEMOAT_AGENT_CHANNEL | tr '[:upper:]' '[:lower:]')`);
  const defaultsChannel = armLines.indexOf('[ "$_agent_channel" = stable ] || _agent_channel=latest');
  const announces = armLines.indexOf('echo "  agents ($_agent_source, refresh only)"');
  const callAt = armLines.findIndex((line) => line.startsWith('"$REPO_ROOT/deploy/agents.sh" --source "$_agent_source" --channel "$_agent_channel"'));
  const call = armLines[callAt] ?? "";
  const guardAt = armLines.indexOf(') || echo "  agents: the script did not finish; the daemon retries daily" >&2');
  const restartAt = armLines.findIndex((line) => line.startsWith("restart_list="));
  check("the daemon arm reads the daemon's env file once, and the daily switch off it first", [envAt !== -1, readsOff === envAt + 1], [true, true]);
  // Read as text: AGENT_UPDATES_OFF lives in scripts/daemon.ts, an entry script this driver must not load.
  const daemonTs = readFileSync(join(repoRoot, "scripts/daemon.ts"), "utf8");
  const offSpellings = /AGENT_UPDATES_OFF: ReadonlySet<string> = new Set\(\[([^\]]+)\]\)/.exec(daemonTs)?.[1]?.match(/"([^"]+)"/g)?.map((one) => one.slice(1, -1)) ?? [];
  check("and honours every spelling the daemon reads as off", [offArm !== -1, offSpellings.length > 0, offSpellings.filter((one) => !(armLines[offArm] ?? "").split(/\s*\|\s*/).map((w) => w.replace(/\)$/, "")).includes(one))], [true, true, []]);
  check(
    "and the daemon reads the source and the channel off its environment through the two readers daemoncheck holds",
    [daemonTs.includes('source: agentSourceFrom(process.env["REEMOAT_AGENT_SOURCE"]'), daemonTs.includes('channel: agentChannelFrom(process.env["REEMOAT_AGENT_CHANNEL"]')],
    [true, true],
  );
  check("then reads the source off the same file, and defaults it to vendor", [readsSource > offArm, defaults === readsSource + 1], [true, true]);
  check("then the channel, lowercased the same way, and defaults it to latest", [readsChannel > defaults, defaultsChannel === readsChannel + 1], [true, true]);
  check("and the two override variables, which the daemon's own run would see", [armLines.indexOf('_agent_claude=$(file_value "$_daemon_env" CLAUDE_CODE_EXECUTABLE)') > defaults, armLines.indexOf('_agent_codex=$(file_value "$_daemon_env" CODEX_PATH)') > defaults], [true, true]);
  check("says which, then runs the same script the bootstrap and the daemon run, with that source", [announces > defaults, callAt > announces], [true, true]);
  check("with node's directory in front, as the bootstrap puts it", armLines.some((line) => line.startsWith('PATH="${NODE_BIN:+$(dirname -- "$NODE_BIN"):}$PATH"')), true);
  check("withholding every prune, since it cannot know which harnesses are live", AGENT_IDS.filter((id) => !call.includes(` --skip ${id}`)), []);
  check("and installing nothing that is not already there", call.includes(" --refresh-only"), true);
  check("with exactly one --skip per harness", (call.match(/ --skip /g) ?? []).length, AGENT_IDS.length);
  check("never fatal, and saying who retries", guardAt === callAt + 1, true);
  check("before the restart decision, so the copies are there when the daemon comes back", callAt !== -1 && restartAt > callAt, true);
  check("and this is the only place deploy.sh reaches the script", deployLines.filter((line) => !/^\s*#/.test(line) && line.includes("deploy/agents.sh")).length, 1);

  const fakeRoot = join(sandbox, "deploy-root");
  const argvLog = join(fakeRoot, "agents-argv");
  const seenLog = join(fakeRoot, "agents-env");
  mkdirSync(join(fakeRoot, "deploy"), { recursive: true });
  const runArm = (env: Record<string, string>, exitWith = 0): { run: Run; argv: string; seen: string } => {
    writeFileSync(
      join(fakeRoot, "deploy", "agents.sh"),
      `#!/bin/sh\nprintf '%s' "$*" > "${argvLog}"\nprintf '%s|%s|%s' "\${CLAUDE_CODE_EXECUTABLE:-}" "\${CODEX_PATH:-}" "\${PATH%%:*}" > "${seenLog}"\nexit ${exitWith}\n`,
    );
    chmodSync(join(fakeRoot, "deploy", "agents.sh"), 0o755);
    rmSync(argvLog, { force: true });
    rmSync(seenLog, { force: true });
    const run = sh(
      [
        `REPO_ROOT="${fakeRoot}"`,
        "touched() { return 1; }",
        'SHARED=; RESTART_DEPS=; svc=daemon; restart_list=""',
        `case "$svc" in\n${daemonArm}\nesac`,
        'printf "restart_list=[%s]\\n" "$restart_list"',
      ].join("\n"),
      env,
    );
    return {
      run,
      argv: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
      seen: existsSync(seenLog) ? readFileSync(seenLog, "utf8") : "",
    };
  };
  // Compared as meaning, not as a string: the script reads --skip into a set, and AGENT_IDS is in a different order.
  type Meaning = { source: string | undefined; channel: string | undefined; skips: string[]; rest: string[] };
  const meaning = (argv: string): Meaning => {
    const tokens = argv.split(" ").filter((one) => one.length > 0);
    const out: Meaning = { source: undefined, channel: undefined, skips: [], rest: [] };
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === "--source") out.source = tokens[++i];
      else if (tokens[i] === "--channel") out.channel = tokens[++i];
      else if (tokens[i] === "--skip") out.skips.push(tokens[++i] ?? "");
      else out.rest.push(tokens[i] as string);
    }
    out.skips.sort();
    return out;
  };
  const everyHarness = [...AGENT_IDS].sort();
  const envDir = join(sandbox, "deploy-env");
  mkdirSync(envDir, { recursive: true });
  const envSaying = (value: string | null, more = ""): string => {
    const file = join(envDir, `${value ?? "absent"}${more.length > 0 ? "-more" : ""}.env`);
    if (value !== null || more.length > 0) writeFileSync(file, `${value === null ? "" : `REEMOAT_AGENT_SOURCE='${value}'\n`}${more}`);
    return file;
  };
  const npmDeploy = runArm({ REEMOAT_ENV_FILE: envSaying("npm") });
  check(
    "an env file saying npm runs the script with --source npm, the channel spelled out, and every prune withheld",
    [npmDeploy.run.status, meaning(npmDeploy.argv), npmDeploy.run.out.includes("  agents (npm, refresh only)\n"), npmDeploy.run.err],
    [0, { source: "npm", channel: "latest", skips: everyHarness, rest: ["--refresh-only"] }, true, ""],
  );
  check("and adds nothing to the restart list by itself", npmDeploy.run.out.includes("restart_list=[]\n"), true);
  const noEnv = runArm({ REEMOAT_ENV_FILE: envSaying(null) });
  check(
    "no env file at all is vendor and latest, which is what the daemon reads absent values as",
    [noEnv.run.status, meaning(noEnv.argv), noEnv.run.out.includes("  agents (vendor, refresh only)\n")],
    [0, { source: "vendor", channel: "latest", skips: everyHarness, rest: ["--refresh-only"] }, true],
  );
  const bogus = runArm({ REEMOAT_ENV_FILE: envSaying("bogus") });
  check("and a spelling that is neither is passed as vendor rather than as itself", [bogus.run.status, meaning(bogus.argv)], [0, { source: "vendor", channel: "latest", skips: everyHarness, rest: ["--refresh-only"] }]);
  const stableDeploy = runArm({ REEMOAT_ENV_FILE: envSaying("npm", "REEMOAT_AGENT_CHANNEL='STABLE'\n") });
  check(
    "an env file saying STABLE passes --channel stable, lowercased as the daemon reads it",
    [stableDeploy.run.status, meaning(stableDeploy.argv), stableDeploy.run.err],
    [0, { source: "npm", channel: "stable", skips: everyHarness, rest: ["--refresh-only"] }, ""],
  );
  const bogusChannel = runArm({ REEMOAT_ENV_FILE: envSaying("vendor", "REEMOAT_AGENT_CHANNEL='nightly'\n") });
  check("and a channel that is neither is passed as latest rather than as itself", [bogusChannel.run.status, meaning(bogusChannel.argv)], [0, { source: "vendor", channel: "latest", skips: everyHarness, rest: ["--refresh-only"] }]);
  const failed = runArm({ REEMOAT_ENV_FILE: envSaying("npm") }, 1);
  check(
    "a script that did not finish is a line on stderr, and the deploy goes on",
    [failed.run.status, failed.run.err.includes("agents: the script did not finish; the daemon retries daily"), failed.run.out.includes("restart_list=[]\n")],
    [0, true, true],
  );
  const switchedOff = runArm({ REEMOAT_ENV_FILE: envSaying("npm", "REEMOAT_AGENT_UPDATES='Off'\n") });
  check(
    "an env file that switches the daily refresh off switches the deploy's off too, and says so",
    [switchedOff.run.status, switchedOff.argv, switchedOff.run.out.includes("agents: off (REEMOAT_AGENT_UPDATES=off)"), switchedOff.run.err],
    [0, "", true, ""],
  );
  const overridden = runArm({ REEMOAT_ENV_FILE: envSaying("vendor", "CLAUDE_CODE_EXECUTABLE='/mine/claude'\nCODEX_PATH='/mine/codex'\n"), NODE_BIN: "/opt/tool/bin/node" });
  check(
    "the overrides in the env file reach the script's environment, and node's directory leads its PATH",
    [overridden.run.status, meaning(overridden.argv).source, overridden.seen],
    [0, "vendor", "/mine/claude|/mine/codex|/opt/tool/bin"],
  );
  const plain = runArm({ REEMOAT_ENV_FILE: envSaying("vendor") });
  check("and with none set the script sees none, rather than an empty string standing for one", plain.seen.startsWith("||"), true);
}

process.stdout.write("\nwhat may close the door on the one-time key\n");

{
  const relayStart = installBlock(
    "the relay's own start",
    'if [ "$SERVICE" = control-plane ] && [ "$START_FAILED" = "0" ]; then',
    "fi",
  );
  const keyGate = installLine("the admin-key gate", 'if [ "$SERVICE" = control-plane ] && [ ! -f "$CPCTL_ENV" ]');

  // The gate line carries its own `if … ; then`, so only the arms are supplied here.
  const gateAfterRelay = (startFailed: string, startRc: string, healthRc: string): string => {
    const out = sh(
      [
        "SERVICE=control-plane",
        `CPCTL_ENV=${join(sandbox, "no-such-cpctl-env")}`,
        `START_FAILED=${startFailed}`,
        "HEALTH_FAILED=0",
        "RELAY_FAILED=0",
        `svc_start() { return ${startRc}; }`,
        `wait_healthy() { return ${healthRc}; }`,
        "log_hint() { printf 'logs-for-%s' \"$1\"; }",
        relayStart,
        `${keyGate} printf 'GATE=open'; else printf 'GATE=shut'; fi`,
        'printf " START=%s RELAY=%s\\n" "$START_FAILED" "$RELAY_FAILED"',
      ].join("\n"),
    ).out;
    return (/GATE=\w+ START=\d RELAY=\d/.exec(out) ?? ["(no verdict)"])[0] as string;
  };

  check("with everything up, the key is captured", gateAfterRelay("0", "0", "0"), "GATE=open START=0 RELAY=0");
  check("a relay that will not start does not close it", gateAfterRelay("0", "1", "0"), "GATE=open START=0 RELAY=1");
  check("nor does one that starts and will not answer", gateAfterRelay("0", "0", "1"), "GATE=open START=0 RELAY=1");
  check("but a control plane that never started still does", gateAfterRelay("1", "0", "0"), "GATE=shut START=1 RELAY=0");

  const finalReport = installBlock(
    "the deferred failure report",
    'if [ "$START_FAILED" != "0" ] || [ "$HEALTH_FAILED" != "0" ] || [ "$RELAY_FAILED" != "0" ]; then',
    "fi",
  );
  const reported = (startFailed: string, healthFailed: string, relayFailed: string): Run =>
    sh(
      [
        "SERVICE=control-plane",
        "log_hint() { printf 'logs-for-%s' \"$1\"; }",
        `START_FAILED=${startFailed}`,
        `HEALTH_FAILED=${healthFailed}`,
        `RELAY_FAILED=${relayFailed}`,
        finalReport,
      ].join("\n"),
    );

  const clean = reported("0", "0", "0");
  check("nothing failed, so nothing is reported and the status is zero", [clean.status, clean.err], [0, ""]);

  const relayOnly = reported("0", "0", "1");
  check("a relay-only failure still fails the install", relayOnly.status, 1);
  check("and names the relay's own logs", relayOnly.err.includes("logs-for-relay"), true);
  check(
    "without claiming the control plane is the thing that is down",
    relayOnly.err.includes("is installed but is not answering"),
    false,
  );

  const apiOnly = reported("0", "1", "0");
  check("an API-only failure names the API's logs", apiOnly.err.includes("logs-for-control-plane"), true);
  check("and not the relay's", apiOnly.err.includes("logs-for-relay"), false);

  const both = reported("0", "1", "1");
  check(
    "and when both are down, both are named",
    [both.err.includes("logs-for-control-plane"), both.err.includes("logs-for-relay"), both.status],
    [true, true, 1],
  );
}

process.stdout.write("\nwhat a runner does, driven without a runner\n");

// Offline seams: SSH=echo turns the remote command into output, and GH is a stub answering the CI verdict.
{
  const ciHome = tmp("cideploy-");
  const stubDir = join(ciHome, "bin");
  mkdirSync(stubDir, { recursive: true });

  const ghStub = (verdict: string): string => {
    const path = join(stubDir, `gh-${verdict}`);
    writeFileSync(path, `#!/bin/sh\necho "${verdict}"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  // Two lines, so "exactly" covers more than the first.
  const pinned = "|1|c2FsdA==|aGFzaA== ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPinned\n|1|c2FsdA==|aGFzaA== ssh-rsa AAAAB3NzaC1yc2EAAAADAQABPinned";

  const run = (env: Record<string, string>): Run => {
    const result = spawnSync("sh", [join(repoRoot, "deploy", "ci-deploy.sh")], {
      cwd: deployDir,
      encoding: "utf8",
      env: {
        PATH: baseEnv.PATH,
        HOME: ciHome,
        SSH: "echo",
        SSH_DIR: join(ciHome, "ssh"),
        GH: ghStub("success"),
        DEPLOY_HOST: "cp.example",
        DEPLOY_USER: "deployer",
        DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n",
        DEPLOY_KNOWN_HOSTS: pinned,
        DEPLOY_REF: "abc123",
        ...env,
      },
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };

  // The first line, not the whole message: the help below it lists every name.
  for (const name of ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_KNOWN_HOSTS", "DEPLOY_REF"]) {
    const without = run({ [name]: "" });
    check(`a missing ${name} refuses before touching a host`, without.status, 2);
    check(`and names it`, without.err.split("\n")[0], `missing: ${name}`);
  }
  const unpinnedDir = join(ciHome, "ssh-unpinned");
  const unpinned = run({ DEPLOY_KNOWN_HOSTS: "", SSH_DIR: unpinnedDir });
  check(
    "an unpinned host is refused rather than scanned: nothing reaches ssh and nothing is written",
    [unpinned.out.includes("deploying"), existsSync(unpinnedDir)],
    [false, false],
  );
  const ciDeploySource = readFileSync(join(deployDir, "ci-deploy.sh"), "utf8");
  check("and nothing in the script can scan for a key", ciDeploySource.includes("ssh-keyscan"), false);
  check(
    "the refusal points at the manual path",
    run({ DEPLOY_HOST: "" }).err.includes("deploy/deploy.sh --ref"),
    true,
  );

  const daemon = run({ DEPLOY_SERVICE: "daemon" });
  check("deploying a daemon from CI is refused", daemon.status, 2);
  check("and the refusal says what it would have cost", daemon.err.includes("pending approval"), true);
  check("while naming the path that is allowed to do it", daemon.err.includes("--service daemon"), true);

  const red = run({ GH: ghStub("failure") });
  check("a commit whose checks failed is not deployed", red.status, 2);
  check("and the verdict is quoted rather than paraphrased", red.err.includes('"failure"'), true);
  const pending = run({ GH: ghStub("none") });
  check("nor one with no completed run at all", pending.status, 2);
  const forced = run({ GH: ghStub("failure"), DEPLOY_SKIP_CHECK_GATE: "1" });
  check("saying so out loud gets past it", forced.status, 0);

  const ok = run({});
  check("a green commit deploys", ok.status, 0);
  check(
    "by calling deploy.sh on the box, with the ref and the service",
    /deploy\/deploy\.sh --ref abc123 --service control-plane/.test(ok.out),
    true,
  );
  check("as the configured user on the configured host", ok.out.includes("deployer@cp.example"), true);
  check("with host-key checking left on", ok.out.includes("StrictHostKeyChecking=no"), false);
  check("and made strict", ok.out.includes("-o StrictHostKeyChecking=yes"), true);
  const knownHostsFile = /-o UserKnownHostsFile=(\S+)/.exec(ok.out)?.[1] ?? "";
  check(
    "against a file holding exactly the pinned keys",
    knownHostsFile !== "" && existsSync(knownHostsFile) ? readFileSync(knownHostsFile, "utf8") : null,
    `${pinned}\n`,
  );
  check("and no other file's", ok.out.includes("-o GlobalKnownHostsFile=/dev/null"), true);
  check("and the directory overridable", run({ DEPLOY_DIR: "/srv/app" }).out.includes("cd /srv/app &&"), true);

  check("the private key is not printed", ok.out.includes("BEGIN OPENSSH") || ok.err.includes("BEGIN OPENSSH"), false);
  check("and no key file is left behind", existsSync(join(ciHome, "ssh", "id_reemoat_deploy")), false);

  const deployYml = readFileSync(join(repoRoot, ".github", "workflows", "deploy.yml"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const required = [...ciDeploySource.matchAll(/missing="\$missing (\w+)"/g)].map((m) => m[1] ?? "");
  check(
    "deploy.yml forwards every secret ci-deploy.sh requires, under its own name",
    required.filter(
      (name) => name !== "DEPLOY_REF" && !deployYml.some((line) => line.trim() === `${name}: \${{ secrets.${name} }}`),
    ),
    [],
  );
  check("including the pinned host keys", required.includes("DEPLOY_KNOWN_HOSTS"), true);
  check("and sets the ref itself", deployYml.some((line) => /DEPLOY_REF=\$\(git rev-parse HEAD\) deploy\/ci-deploy\.sh/.test(line)), true);
}

process.stdout.write("\nwhat a release does, driven without a registry\n");

// Seams: GH is the forge, DOCKER echoes anything bound for a registry, RELEASE_ROOT is the tree whose versions are read.
{
  const relHome = tmp("cirelease-");
  const relBin = join(relHome, "bin");
  mkdirSync(relBin, { recursive: true });

  let stubSeq = 0;
  const stub = (body: string): string => {
    stubSeq += 1;
    const path = join(relBin, `stub-${stubSeq}`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  // Keyed on `$1 $2`: keyed on `$1` alone, `release view` and `release create` would share an arm.
  const gh = (verdict: string): string =>
    stub(
      `case "$1 $2" in\n` +
        `  "run list") echo "${verdict}" ;;\n` +
        `  "release view") exit 1 ;;\n` +
        `  "release create") echo "created $*" ;;\n` +
        `esac`,
    );

  const ghWithRelease = stub(
    `case "$1 $2" in\n` +
      `  "run list") echo "success" ;;\n` +
      `  "release view") exit 0 ;;\n` +
      `  "release create") echo "created $*" ;;\n` +
      `esac`,
  );

  // The `--format` arm answers a digest because `manifest` inspects the tag it just created.
  const dockerEcho = stub(
    `case "$*" in\n` +
      `  *"imagetools inspect"*"--format"*) echo '"sha256:00ff"' ;;\n` +
      `  *"imagetools inspect"*) exit 1 ;;\n` +
      `  *) echo "docker $*" ;;\n` +
      `esac`,
  );

  const dockerPublished = stub(`exit 0`);

  interface Tree {
    version?: string;
    webVersion?: string;
    cpVersion?: string;
    offerVersion?: string;
    changelogVersion?: string;
    daemonVersion?: string;
    sourceUrl?: string;
    license?: string;
    homepage?: string;
    author?: string;
    description?: string;
    notes?: string;
    rootManifest?: string;
    productName?: string;
    /** The platform whose overlay keeps the daemon payload, which makes the `app_profile` refusal reachable. */
    overlayKeepingPayload?: string;
  }

  const fixture = (t: Tree = {}): string => {
    const v = t.version ?? "0.1.0";
    const source = t.sourceUrl ?? "https://github.com/rends-east/reemoat";
    const dir = tmp("reltree-");
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    mkdirSync(join(dir, "packages", "control-plane", "src"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "deploy", "docker"), { recursive: true });
    // `publish` uploads this as the release's install.sh asset, so every releasable tree needs one.
    writeFileSync(join(dir, "deploy", "bootstrap.sh"), "#!/bin/sh\nmain() { :; }\nmain \"$@\"\n");
    // ci-release.sh reads productName before the verb dispatch, and `app_profile` reads the overlays.
    mkdirSync(join(dir, "packages", "native", "src-tauri"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "native", "src-tauri", "tauri.conf.json"),
      JSON.stringify({ productName: t.productName ?? "Reemoat" }, null, 2),
    );
    for (const platform of ["linux", "windows", "android", "ios"]) {
      writeFileSync(
        join(dir, "packages", "native", "src-tauri", `tauri.${platform}.conf.json`),
        // `resources: null` alone is the half-edit the `app_profile` refusal exists for.
        JSON.stringify(
          platform === t.overlayKeepingPayload
            ? { bundle: { resources: null } }
            : { bundle: { externalBin: null, resources: null } },
          null,
          2,
        ),
      );
    }

    writeFileSync(
      join(dir, "package.json"),
      t.rootManifest ??
        JSON.stringify(
          {
            name: "reemoat",
            version: v,
            license: t.license ?? "AGPL-3.0-only",
            author: t.author ?? "rends-east",
            homepage: t.homepage ?? "https://reemoat.com",
            repository: { type: "git", url: `git+${source}.git` },
          },
          null,
          2,
        ),
    );
    writeFileSync(
      join(dir, "packages", "web", "package.json"),
      JSON.stringify({ name: "@reemoat/web", version: t.webVersion ?? v }, null, 2),
    );
    writeFileSync(
      join(dir, "packages", "control-plane", "package.json"),
      JSON.stringify(
        {
          name: "@reemoat/control-plane",
          version: t.cpVersion ?? v,
          description: t.description ?? "The reemoat control plane.",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(dir, "packages", "control-plane", "src", "app.ts"),
      `const SOURCE_URL = "${source}";\nconst VERSION = "${t.offerVersion ?? v}";\n`,
    );
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      `# Changelog\n\n## [Unreleased]\n\n## [${t.changelogVersion ?? v}] - 2026-08-17\n\n` +
        `${t.notes ?? "### Added\n\n- The first one.\n"}\n` +
        `[Unreleased]: https://example.invalid/compare\n[${t.changelogVersion ?? v}]: https://example.invalid/tag\n`,
    );
    writeFileSync(
      join(dir, "src", "version.ts"),
      `export const DAEMON_VERSION = "${t.daemonVersion ?? v}";\n`,
    );
    writeFileSync(join(dir, "deploy", "docker", "Dockerfile"), "FROM scratch\n");
    return dir;
  };

  const release = (
    verb: string,
    env: Record<string, string> = {},
    root: string = fixture(),
  ): Run => {
    const result = spawnSync("sh", [join(repoRoot, "deploy", "ci-release.sh"), verb], {
      cwd: deployDir,
      encoding: "utf8",
      env: {
        PATH: baseEnv.PATH,
        HOME: relHome,
        GH: gh("success"),
        DOCKER: dockerEcho,
        RELEASE_ROOT: root,
        RELEASE_TAG: "v0.1.0",
        RELEASE_REF: "abc123def4567",
        RELEASE_WORK: join(tmp("relwork-"), "w"),
        ...env,
      },
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };

  for (const name of ["RELEASE_TAG", "RELEASE_REF"]) {
    const without = release("plan", { [name]: "" });
    check(`a release missing ${name} refuses before touching a registry`, without.status, 2);
    check(`and names it`, without.err.includes(name), true);
  }
  check(
    "the refusal says how a release is actually started",
    release("plan", { RELEASE_TAG: "" }).err.includes("git tag"),
    true,
  );

  check("an unknown verb is refused rather than assumed", release("frobnicate").status, 2);
  check("and so is no verb at all", release("").status, 2);

  check("a tag that is not a version is refused", release("plan", { RELEASE_TAG: "nightly" }).status, 2);
  check("a tag missing its v is refused", release("plan", { RELEASE_TAG: "0.1.0" }).status, 2);
  check("a two-part version is refused", release("plan", { RELEASE_TAG: "v0.1" }).status, 2);
  const pre = release("plan", { RELEASE_TAG: "v0.2.0-rc.1" });
  check("a prerelease is refused by name rather than accepted quietly", pre.status, 2);
  check("and the refusal says what deciding it would cost", pre.err.includes("CHANGELOG"), true);

  const disagreements: Array<[string, Tree, string]> = [
    ["the root manifest", { version: "0.9.0" }, "package.json"],
    ["packages/web", { webVersion: "0.9.0" }, "packages/web/package.json"],
    ["packages/control-plane", { cpVersion: "0.9.0" }, "packages/control-plane/package.json"],
    ["the source offer", { offerVersion: "0.9.0" }, "app.ts"],
    ["the CHANGELOG", { changelogVersion: "0.9.0" }, "CHANGELOG.md"],
    ["the daemon's own literal", { daemonVersion: "0.9.0" }, "src/version.ts"],
  ];
  for (const [what, tree, named] of disagreements) {
    const bad = release("plan", {}, fixture(tree));
    check(`a tag ${what} does not claim is refused`, bad.status, 2);
    check(`and the refusal names ${named}`, bad.err.includes(named), true);
  }

  const reformatted = release("plan", {}, fixture({ rootManifest: `{"name":"reemoat","version" : "0.1.0"}` }));
  check("a manifest whose version line stopped matching fails as loudly", reformatted.status, 2);
  check("and says the pattern is what to fix", reformatted.err.includes("reformatted"), true);

  const empty = release("plan", {}, fixture({ notes: "" }));
  check("a version with an empty CHANGELOG section is refused", empty.status, 2);

  const red = release("plan", { GH: gh("failure") });
  check("a commit whose checks failed is not released", red.status, 2);
  check("and the verdict is quoted rather than paraphrased", red.err.includes('"failure"'), true);
  check("nor one with no completed run at all", release("plan", { GH: gh("none") }).status, 2);
  check(
    "saying so out loud gets past it",
    release("plan", { GH: gh("failure"), RELEASE_SKIP_CHECK_GATE: "1" }).status,
    0,
  );

  const ghPendingThen = (later: string, pendings: number): string =>
    stub(
      `case "$1 $2" in\n` +
        `  "run list")\n` +
        `    n=0\n` +
        `    [ -f "$GH_PENDING_COUNT" ] && n=$(cat "$GH_PENDING_COUNT")\n` +
        `    n=$((n + 1)); echo "$n" > "$GH_PENDING_COUNT"\n` +
        `    if [ "$n" -le ${pendings} ]; then echo "pending"; else echo "${later}"; fi ;;\n` +
        `  "release view") exit 1 ;;\n` +
        `  "release create") echo "created $*" ;;\n` +
        `esac`,
    );

  {
    const counter = join(tmp("ghcount-"), "n");
    const waits = release("plan", {
      GH: ghPendingThen("success", 2),
      GH_PENDING_COUNT: counter,
      RELEASE_CHECK_POLL_SECONDS: "0",
      RELEASE_CHECK_WAIT_SECONDS: "60",
    });
    check("a check still running is waited for rather than refused", waits.status, 0);
    check("and the wait is visible rather than a silent stall", waits.out.includes("still running"), true);
    check("and it polled more than once", waits.out.split("still running").length - 1 >= 2, true);
  }

  {
    const counter = join(tmp("ghcount-"), "n");
    const red = release("plan", {
      GH: ghPendingThen("failure", 1),
      GH_PENDING_COUNT: counter,
      RELEASE_CHECK_POLL_SECONDS: "0",
      RELEASE_CHECK_WAIT_SECONDS: "60",
    });
    check("a check that goes on to fail is still refused after the wait", red.status, 2);
    check("and names the conclusion, not the waiting", red.err.includes('"failure"'), true);
  }

  {
    const counter = join(tmp("ghcount-"), "n");
    const timedOut = release("plan", {
      GH: ghPendingThen("success", 99),
      GH_PENDING_COUNT: counter,
      RELEASE_CHECK_POLL_SECONDS: "0",
      RELEASE_CHECK_WAIT_SECONDS: "0",
    });
    check("a check that never finishes refuses at the deadline", timedOut.status, 2);
    check("and says it was still going rather than blaming the commit", timedOut.err.includes("still going"), true);
  }

  {
    const noRun = release("plan", {
      GH: gh("none"),
      RELEASE_CHECK_POLL_SECONDS: "0",
      RELEASE_CHECK_WAIT_SECONDS: "60",
    });
    check("a commit with no check run at all refuses without waiting", noRun.status, 2);
    check("and never says it waited", noRun.out.includes("still running"), false);
  }

  const hasRelease = release("plan", { GH: ghWithRelease });
  check("a tag that already has a release is refused", hasRelease.status, 2);
  const hasImage = release("plan", { DOCKER: dockerPublished });
  check("a tag whose image already exists is refused", hasImage.status, 2);
  check(
    "and the refusal says what moving a tag costs somebody who pulled it",
    hasImage.err.includes("pulled"),
    true,
  );
  check(
    "saying so out loud gets past both",
    release("plan", { GH: ghWithRelease, DOCKER: dockerPublished, RELEASE_ALLOW_RETAG: "1" }).status,
    0,
  );

  const publishWork = join(tmp("relpub-"), "w");
  mkdirSync(publishWork, { recursive: true });
  writeFileSync(join(publishWork, "notes.md"), "notes\n");
  // These publish cases carry no app targets; the missing-artifact gate is driven on its own below.
  const noApps = { RELEASE_APP_TARGETS: "" };
  check(
    "publish is not blocked by the image manifest just created",
    release("publish", { DOCKER: dockerPublished, RELEASE_WORK: publishWork, ...noApps }).status,
    0,
  );

  const planned = release("plan");
  check("a green tag plans", planned.status, 0);
  check("the image is published under the expected name", planned.out.includes("ghcr.io/"), true);
  check("the version tag is the git tag verbatim", planned.out.includes("tag_version=") && planned.out.includes(":v0.1.0"), true);
  check("the commit gets a tag of its own, which is the one a rollback wants", /tag_sha=\S+:sha-abc123def456\b/.test(planned.out), true);
  check("latest is offered", planned.out.includes(":latest"), true);
  check("and withheld when it is asked to be", release("plan", { RELEASE_LATEST: "0" }).out.includes("tag_latest=\n"), true);
  check("there is no rolling minor tag", /:0\.1(\s|$)/.test(planned.out), false);
  check("nor a rolling major one", /:0(\s|$)/.test(planned.out), false);

  const notesWork = join(tmp("relnotes-"), "w");
  const notesRun = release("plan", { RELEASE_WORK: notesWork });
  const notesText = readFileSync(join(notesWork, "notes.md"), "utf8");
  check("the notes carry the section somebody wrote", notesText.includes("The first one."), true);
  check("and stop before the link-reference block", notesText.includes("[Unreleased]:"), false);
  check("and before the next heading", notesText.includes("## ["), false);
  check("plan says where it put them", notesRun.out.includes("notes_file="), true);

  const built = release("image");
  const argv = built.out;
  check("the image build is buildx", argv.includes("buildx build"), true);
  check("built from the repository root with the same Dockerfile compose builds", argv.includes("deploy/docker/Dockerfile"), true);
  check("pushed by digest rather than by tag", argv.includes("push-by-digest=true"), true);
  check("and claiming no tag, so two architectures cannot race for one", argv.includes("--tag"), false);
  check("and never --load, which is imagecheck's requirement and not this one", argv.includes("--load"), false);
  check("the platform reaches the build unchanged", argv.includes("--platform linux/amd64"), true);
  check(
    "and is the one variable that decides the architectures",
    release("image", { RELEASE_PLATFORM: "linux/arm64" }).out.includes("--platform linux/arm64"),
    true,
  );
  check("buildx's own provenance export is off, since the attestation is the one mechanism", argv.includes("--provenance=false"), true);

  // Proved by mutating the fixture: an equality check would also pass a transcribed label.
  const labelFollows = (name: string, tree: Tree, expected: string): void => {
    const out = release("image", {}, fixture(tree)).out;
    check(`the ${name} label is read from the tree rather than transcribed`, out.includes(expected), true);
  };
  labelFollows("source", { sourceUrl: "https://example.invalid/fork" }, "image.source=https://example.invalid/fork");
  labelFollows("licence", { license: "MIT" }, "image.licenses=MIT");
  labelFollows("url", { homepage: "https://elsewhere.example" }, "image.url=https://elsewhere.example");
  labelFollows("vendor", { author: "somebody-else" }, "image.vendor=somebody-else");
  labelFollows("description", { description: "Something else entirely." }, "image.description=Something else entirely.");
  check("the version label is the tag without its v", argv.includes("image.version=0.1.0"), true);
  check("the revision label is the commit and not the tag", argv.includes("image.revision=abc123def4567"), true);
  check("the created label is UTC", /image\.created=\d{4}-\d{2}-\d{2}T[\d:]+Z/.test(argv), true);
  const offerLed = release("image", {}, fixture({ sourceUrl: "https://example.invalid/fork" })).out;
  check("the source label follows the section 13 offer specifically", offerLed.includes("image.source=https://example.invalid/fork"), true);

  const digestDir = join(tmp("reldigests-"), "d");
  mkdirSync(digestDir, { recursive: true });
  writeFileSync(join(digestDir, "linux-amd64"), "sha256:aa11\n");
  const merged = release("manifest", { RELEASE_DIGEST_DIR: digestDir });
  check("the final tags are created from digests rather than rebuilt", merged.out.includes("imagetools create"), true);
  check("naming every digest that was pushed", merged.out.includes("@sha256:aa11"), true);
  check("and it emits the index digest the attestation needs", merged.out.includes("digest=sha256:00ff"), true);
  const noDigests = join(tmp("relempty-"), "d");
  mkdirSync(noDigests, { recursive: true });
  check("and it refuses with no digests at all", release("manifest", { RELEASE_DIGEST_DIR: noDigests }).status, 2);

  const published = release("publish", { RELEASE_WORK: publishWork, ...noApps });
  check("the release is created from the section somebody wrote", published.out.includes("publishing v0.1.0"), true);
  check(
    "and the release carries the installer people are told to download",
    /release create[\s\S]*\/install\.sh/.test(published.out),
    true,
  );
  check("publish refuses when plan never wrote the notes", release("publish").status, 2);

  process.stdout.write("\nthe app verb, and what it refuses\n");

  const tauriEcho = stub('echo "tauri $*"');
  // Writes the file, never the directory alone: an empty bundle directory is its own refusal.
  const tauriProduces = (relative: string): string =>
    stub(`out="$TAURI_FIXTURE_ROOT/${relative}"; mkdir -p "$(dirname "$out")"; printf 'bundle\\n' > "$out"; echo "tauri $*"`);
  const tauriProducesAll = (relatives: readonly string[]): string =>
    stub(
      relatives
        .map((r) => `out="$TAURI_FIXTURE_ROOT/${r}"; mkdir -p "$(dirname "$out")"; printf 'bundle\\n' > "$out"`)
        .join("\n") + `\necho "tauri $*"`,
    );
  const tauriProducesEmpty = (relative: string): string =>
    stub(`out="$TAURI_FIXTURE_ROOT/${relative}"; mkdir -p "$(dirname "$out")"; : > "$out"; echo "tauri $*"`);
  const nodeEcho = stub('echo "node $*"');

  const app = (target: string, env: Record<string, string> = {}, root?: string): Run => {
    const tree = root ?? fixture();
    return release(
      "app",
      {
        RELEASE_APP_TARGET: target,
        RELEASE_APP_TARGETS: target,
        TAURI: tauriEcho,
        NODE: nodeEcho,
        TAURI_FIXTURE_ROOT: tree,
        ...env,
      },
      tree,
    );
  };

  check("app with no target is refused", app("").status, 2);
  const unknown = app("plan9");
  check("an unknown app target is refused rather than assumed", unknown.status, 2);
  check("and the refusal names every target this release knows", unknown.err.includes("macos-arm64 macos-x64 linux-x64 linux-arm64 windows-x64 android"), true);
  check("and says check.yml is the other half of adding one", unknown.err.includes("check.yml"), true);
  const notAsked = app("windows-x64", { RELEASE_APP_TARGETS: "macos-arm64" });
  check("a known target that is not in RELEASE_APP_TARGETS is refused", notAsked.status, 2);
  check("and the refusal says the matrix has drifted from the list", notAsked.err.includes("drifted"), true);

  // Read off a client target: a daemon-host target refuses at staging, before the bundler.
  const winArgv = app("windows-x64");
  check("the app build names the triple it was asked for", winArgv.out.includes("--target x86_64-pc-windows-msvc"), true);
  check("and RELEASE_APP_TARGET is the one variable that decides it", app("linux-x64").out.includes("--target x86_64-unknown-linux-gnu"), true);
  check("and it passes no --bundles, the overlay being where kinds are written", winArgv.out.includes("--bundles"), false);
  const androidKey: Record<string, string> = {
    RELEASE_ANDROID_KEYSTORE: "eA==",
    RELEASE_ANDROID_KEYSTORE_PASSWORD: "p",
    RELEASE_ANDROID_KEY_ALIAS: "a",
    RELEASE_ANDROID_KEY_PASSWORD: "k",
  };
  check(
    "android is built through the android subcommand rather than the desktop one",
    app("android", androidKey).out.includes("android build --apk"),
    true,
  );
  // Each key is blanked alone and the missing list compared whole: RELEASE_ANDROID_KEYSTORE prefixes the password's name.
  for (const blank of [
    "RELEASE_ANDROID_KEYSTORE",
    "RELEASE_ANDROID_KEYSTORE_PASSWORD",
    "RELEASE_ANDROID_KEY_ALIAS",
    "RELEASE_ANDROID_KEY_PASSWORD",
  ]) {
    const oneShort = app("android", { ...androidKey, [blank]: "" });
    check(`android with ${blank} unset is refused`, oneShort.status, 2);
    check(`and the bundler is never reached without ${blank}`, oneShort.out.includes("android build --apk"), false);
    const listed = (/android is being built and([^\n]*) is unset\./.exec(oneShort.err)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    check(`and the refusal names ${blank} and none of the other three`, listed, [blank]);
  }

  const APK_REL = "packages/native/src-tauri/gen/android/app/build/outputs/apk/universal/release";
  const androidSecrets = {
    RELEASE_ANDROID_KEYSTORE: "eA==",
    RELEASE_ANDROID_KEYSTORE_PASSWORD: "p",
    RELEASE_ANDROID_KEY_ALIAS: "a",
    RELEASE_ANDROID_KEY_PASSWORD: "k",
  };
  // Modelled on apksig: v1 is consulted only below min SDK 24 (the manifest floor), and scheme lines print only under --verbose.
  const apksignerFor = (apk: { jar: boolean; v2: boolean }): string =>
    stub(
      [
        'echo "apksigner $*"',
        "floor=24; verbose=0; prev=",
        'for arg in "$@"; do',
        '  if [ "$prev" = --min-sdk-version ]; then floor=$arg; fi',
        '  if [ "$arg" = --verbose ]; then verbose=1; fi',
        "  prev=$arg",
        "done",
        "v1=false",
        'if [ "$floor" -lt 24 ]; then',
        apk.jar
          ? "  v1=true"
          : '  echo "DOES NOT VERIFY" >&2; echo "ERROR: Missing META-INF/MANIFEST.MF" >&2; exit 1',
        "fi",
        '[ "$verbose" = 1 ] || exit 0',
        'echo "Verifies"',
        'echo "Verified using v1 scheme (JAR signing): $v1"',
        `echo "Verified using v2 scheme (APK Signature Scheme v2): ${String(apk.v2)}"`,
        'echo "Verified using v3 scheme (APK Signature Scheme v3): false"',
      ].join("\n"),
    );
  const apksignerOk = apksignerFor({ jar: true, v2: true });
  const apksignerV2Only = apksignerFor({ jar: false, v2: true });
  const apksignerNoV2 = apksignerFor({ jar: true, v2: false });
  const apksignerBad = stub('echo "apksigner $*" >&2; exit 1');
  // Reports the keystore from inside the run: the trap removes it before spawnSync returns.
  // `ls -l` rather than stat, whose mode flag differs between GNU and BSD.
  const tauriAndroid = (apkName: string): string =>
    stub(
      `out="$TAURI_FIXTURE_ROOT/${APK_REL}/${apkName}"; mkdir -p "$(dirname "$out")"; printf 'apk\\n' > "$out"\n` +
        'echo "tauri $*"\n' +
        'echo "keystore-path $ANDROID_KEYSTORE_PATH"\n' +
        'echo "keystore-mode $(ls -l "$ANDROID_KEYSTORE_PATH" | cut -c1-10)"\n' +
        'echo "keystore-bytes $(wc -c < "$ANDROID_KEYSTORE_PATH" | tr -d " ")"',
    );

  const androidWork = join(tmp("relwork-android-"), "w");
  const signed = app("android", {
    ...androidSecrets,
    RELEASE_WORK: androidWork,
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: apksignerOk,
  });
  check("and a signed build names its asset", /app: android \S+-android\.apk \d+ bytes/.test(signed.out), true);
  check(
    "and its log says both schemes verified, asked from below API 24",
    [
      signed.out.includes("--min-sdk-version 23"),
      signed.out.includes("Verified using v1 scheme (JAR signing): true"),
      signed.out.includes("Verified using v2 scheme (APK Signature Scheme v2): true"),
    ],
    [true, true, true],
  );

  const keystorePath = /keystore-path (\S+)/.exec(signed.out)?.[1] ?? "";
  check("the keystore is written with no bits for anybody but this user", /keystore-mode (\S+)/.exec(signed.out)?.[1] ?? null, "-rw-------");
  check("and it is the decoded secret rather than an empty file", /keystore-bytes (\d+)/.exec(signed.out)?.[1] ?? null, "1");
  check("and it does not live inside RELEASE_WORK", keystorePath.length > 0 && keystorePath.startsWith(androidWork), false);
  check("and nothing is left on disk once the verb returns", keystorePath.length > 0 && existsSync(keystorePath), false);
  const releaseText = readFileSync(join(repoRoot, "deploy", "ci-release.sh"), "utf8");
  const armedAt = releaseText.indexOf("trap 'rm -rf \"$android_key_dir\"'");
  const wroteAt = releaseText.indexOf('base64 -d > "$ANDROID_KEYSTORE_PATH"');
  check("the keystore trap is armed before anything secret is written", [armedAt > 0, wroteAt > 0, armedAt < wroteAt], [true, true, true]);

  const emptyKey = app("android", {
    ...androidSecrets,
    RELEASE_ANDROID_KEYSTORE: "\n",
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: apksignerOk,
  });
  check("a keystore secret that decodes to nothing is refused", emptyKey.status, 2);
  check("and the refusal says it is the secret rather than the toolchain", emptyKey.err.includes("decoded to nothing"), true);

  const unsigned = app("android", {
    ...androidSecrets,
    TAURI: tauriAndroid("app-universal-release-unsigned.apk"),
    APKSIGNER: apksignerOk,
  });
  check("an unsigned APK is refused rather than published under the signed name", unsigned.status, 2);
  check("and the refusal names the file AGP actually wrote", unsigned.err.includes("app-universal-release-unsigned.apk"), true);
  check("and names the Gradle daemon, which is how it happens", unsigned.err.includes("--no-daemon"), true);

  const badSig = app("android", {
    ...androidSecrets,
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: apksignerBad,
  });
  check("an APK at the signed name whose signature does not verify is refused", badSig.status, 2);
  check("and the refusal says so rather than blaming the name", badSig.err.includes("not validly signed"), true);

  const v2Only = app("android", {
    ...androidSecrets,
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: apksignerV2Only,
  });
  check("an APK signed with v2 alone is refused, which 0.10.1's was not", v2Only.status, 2);
  check(
    "and the refusal names the JAR scheme, carries apksigner's reason, and does not call it unsigned",
    [
      v2Only.err.includes("does not verify using the v1 scheme (JAR signing)"),
      v2Only.err.includes("Missing META-INF/MANIFEST.MF"),
      v2Only.err.includes("not validly signed"),
    ],
    [true, true, false],
  );
  check("and no asset is named for it", /app: android \S+-android\.apk/.test(v2Only.out), false);
  const noV2 = app("android", {
    ...androidSecrets,
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: apksignerNoV2,
  });
  check(
    "an APK with the JAR signature and no v2 is refused too, and the refusal names v2",
    [noV2.status, noV2.err.includes("does not verify using the v2 scheme (APK Signature Scheme v2)")],
    [2, true],
  );
  const askedFrom = (args: readonly string[]): string =>
    spawnSync(apksignerOk, ["verify", "--verbose", ...args, "app.apk"], { encoding: "utf8" }).stdout ?? "";
  check(
    "the model answers v1 false at the manifest's floor and true below it, as apksig does",
    [
      askedFrom([]).includes("Verified using v1 scheme (JAR signing): false"),
      askedFrom(["--min-sdk-version", "23"]).includes("Verified using v1 scheme (JAR signing): true"),
    ],
    [true, true],
  );

  const noSigner = app("android", {
    ...androidSecrets,
    TAURI: tauriAndroid("app-universal-release.apk"),
    APKSIGNER: "",
    ANDROID_HOME: "",
    ANDROID_SDK_ROOT: "",
  });
  check("a missing apksigner is a refusal rather than a skipped check", noSigner.status, 2);
  check("and the refusal says where it comes from", noSigner.err.includes("build-tools"), true);
  const macArgv = app("macos-arm64");
  check("a daemon-host target stages the runtime first", macArgv.out.includes("build-daemon.mjs aarch64-apple-darwin"), true);
  check("and refuses when nothing was staged", macArgv.status, 2);
  check("a client target stages nothing at all", app("windows-x64").out.includes("build-daemon.mjs"), false);
  check("and still reaches the bundler", app("windows-x64").out.includes("tauri "), true);
  const staleTree = fixture();
  mkdirSync(join(staleTree, "packages", "native", "src-tauri", "binaries"), { recursive: true });
  writeFileSync(join(staleTree, "packages", "native", "src-tauri", "binaries", "node-x86_64-pc-windows-msvc"), "x");
  const stale = app("windows-x64", {}, staleTree);
  check("a client target with a staged runtime left behind is refused", stale.status, 2);
  check("and the refusal names the file rather than the class", stale.err.includes("node-x86_64-pc-windows-msvc"), true);

  const keepsPayload = app("linux-x64", {}, fixture({ overlayKeepingPayload: "linux" }));
  check("a client target whose overlay stopped taking the payload away is refused", keepsPayload.status, 2);
  check(
    "and the refusal names the overlay that has to say it",
    keepsPayload.err.includes("tauri.linux.conf.json does not take the daemon payload away"),
    true,
  );
  check("and it refuses before the bundler rather than after", keepsPayload.out.includes("tauri "), false);
  check(
    "while the overlay every other case writes is not refused for that reason",
    app("linux-x64").err.includes("does not take the daemon payload away"),
    false,
  );

  const noBundle = app("windows-x64");
  check("a build that produced no bundle is refused", noBundle.status, 2);
  check("and says the absence means the build did not finish", noBundle.err.includes("did not finish"), true);

  const made = (target: string, relative: string, env: Record<string, string> = {}): Run => {
    const tree = fixture();
    return app(target, { TAURI: tauriProduces(relative), ...env }, tree);
  };
  const win = made("windows-x64", "packages/native/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Reemoat_0.1.0_x64-setup.exe");
  check("a client target that produced a bundle names its asset", win.status, 0);
  check("the asset name carries the version the tag names", win.out.includes("Reemoat-0.1.0-windows-x64-setup.exe"), true);
  const forked = fixture({ productName: "Nomeer" });
  const renamed = app(
    "windows-x64",
    { TAURI: tauriProduces("packages/native/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/x-setup.exe") },
    forked,
  );
  check(
    "and the product name is read from the configuration rather than transcribed",
    renamed.out.includes("Nomeer-0.1.0-windows-x64-setup.exe"),
    true,
  );
  // Read off the `app:` line: the progress output already names the triple.
  const winAsset = /^app: \S+ (\S+) /m.exec(win.out)?.[1] ?? "";
  check("the app: line names an asset at all", winAsset.length > 0, true);
  check("and the OS token is the one the app reports about itself", winAsset.split("-").includes("windows"), true);
  check("and it is the OS spelling rather than the triple's", winAsset.includes("msvc"), false);
  check("and no asset name carries a space, which GitHub would rewrite", winAsset.includes(" "), false);

  const linuxBundle = "packages/native/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle";
  const winNsis = "packages/native/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis";

  const bothLinux = app("linux-x64", {
    TAURI: tauriProducesAll([
      `${linuxBundle}/deb/reemoat_0.1.0_amd64.deb`,
      `${linuxBundle}/appimage/reemoat_0.1.0_amd64.AppImage`,
    ]),
  });
  check("a leg that produces two artifacts names both", bothLinux.status, 0);
  check("and it is two app: lines rather than one", (bothLinux.out.match(/^app: /gm) ?? []).length, 2);
  check("the deb is one of them", bothLinux.out.includes("Reemoat-0.1.0-linux-x64.deb"), true);
  check("and the AppImage the same build produced is the other", bothLinux.out.includes("Reemoat-0.1.0-linux-x64.AppImage"), true);

  const twoDebs = app("linux-x64", {
    TAURI: tauriProducesAll([
      `${linuxBundle}/deb/reemoat_0.1.0_amd64.deb`,
      `${linuxBundle}/deb/reemoat_0.0.9_amd64.deb`,
    ]),
  });
  check("a glob that matches two files is refused rather than resolved", twoDebs.status, 2);
  check("and the refusal counts them", twoDebs.err.includes("matched 2 files"), true);
  check("and says the build directory is what to clean", twoDebs.err.includes("Clean the build directory"), true);
  check("and nothing was packaged under this release's name", twoDebs.out.includes("app: "), false);

  const seeded = join(tmp("relseed-"), "w");
  mkdirSync(join(seeded, "apps"), { recursive: true });
  writeFileSync(join(seeded, "apps", "Reemoat-0.1.0-windows-x64-setup.exe"), "an older one\n");
  const occupied = app("windows-x64", {
    TAURI: tauriProduces(`${winNsis}/Reemoat_0.1.0_x64-setup.exe`),
    RELEASE_WORK: seeded,
  });
  check("an asset name already in the output directory is refused", occupied.status, 2);
  check(
    "and the refusal names the asset rather than the file it came from",
    occupied.err.includes("Reemoat-0.1.0-windows-x64-setup.exe is already in"),
    true,
  );
  check(
    "and what was there is still what is there",
    readFileSync(join(seeded, "apps", "Reemoat-0.1.0-windows-x64-setup.exe"), "utf8"),
    "an older one\n",
  );

  const hollow = app("windows-x64", { TAURI: tauriProducesEmpty(`${winNsis}/Reemoat_0.1.0_x64-setup.exe`) });
  check("a bundle the bundler wrote nothing into is refused", hollow.status, 2);
  check("and the refusal names the asset and says it is empty", hollow.err.includes("Reemoat-0.1.0-windows-x64-setup.exe is empty"), true);
  check("and it never reaches the app: line", hollow.out.includes("app: "), false);

  const collided = release("plan", { RELEASE_APP_TARGETS: "windows-x64 windows-x64" });
  check("plan refuses two targets that compute one asset name", collided.status, 2);
  check("and names the asset both of them wanted", collided.err.includes("two targets both produce Reemoat-0.1.0-windows-x64-setup.exe"), true);
  check("and it refuses before writing anything", collided.out.includes("notes_file="), false);

  const partialWork = join(tmp("relpart-"), "w");
  mkdirSync(join(partialWork, "apps"), { recursive: true });
  writeFileSync(join(partialWork, "notes.md"), "notes\n");
  writeFileSync(join(partialWork, "apps", "Reemoat-0.1.0-windows-x64-setup.exe"), "x");
  const partial = release("publish", {
    RELEASE_WORK: partialWork,
    RELEASE_APP_TARGETS: "windows-x64 macos-arm64",
  });
  check("publish refuses a release missing an artifact it said it would carry", partial.status, 2);
  check("and names the one that is missing", partial.err.includes("Reemoat-0.1.0-macos-arm64.app.zip"), true);
  check("and not the one that is there", partial.err.includes("windows-x64-setup.exe"), false);
  const whole = release("publish", { RELEASE_WORK: partialWork, RELEASE_APP_TARGETS: "windows-x64" });
  check("and publishes when every named artifact is there", whole.status, 0);
  check("with the app artifact on the same call as the installer", /release create[\s\S]*install\.sh[\s\S]*windows-x64-setup\.exe/.test(whole.out), true);
  check("and there is no second upload call", whole.out.includes("release upload"), false);

  // Asserted on status and on the work not happening: `fail` inside a command substitution exits only the subshell.
  const typoed = "windows-x64 windwos-x64";
  const typoWork = join(tmp("reltypo-"), "w");
  const planTypo = release("plan", { RELEASE_APP_TARGETS: typoed, RELEASE_WORK: typoWork });
  check("plan refuses a name RELEASE_APP_TARGETS has and the table does not", planTypo.status, 2);
  check("and quotes the one it could not resolve", planTypo.err.includes('names "windwos-x64"'), true);
  check("and offers the list it does know", planTypo.err.includes("macos-arm64 macos-x64 linux-x64 linux-arm64 windows-x64 android"), true);
  check("and the notes it would have written are not there", existsSync(join(typoWork, "notes.md")), false);
  check("nor did it emit a single output", planTypo.out.includes("notes_file="), false);
  const publishTypo = release("publish", { RELEASE_WORK: partialWork, RELEASE_APP_TARGETS: typoed });
  check("publish refuses the same name from its own call site", publishTypo.status, 2);
  check("and quotes it too", publishTypo.err.includes('names "windwos-x64"'), true);
  check("and no release was created", publishTypo.out.includes("created "), false);
  check("a list the table knows is not refused", release("plan", { RELEASE_APP_TARGETS: "windows-x64 macos-arm64" }).status, 0);
  check(
    "and neither is the empty default, which is what this release publishes today",
    release("plan").err.includes("not a target this release knows"),
    false,
  );

  // AGPL §6: no .app bundler reads licenseFile, so the source offer rides the release notes and names this tag.
  const offerWork = join(tmp("reloffer-"), "w");
  release("plan", { RELEASE_WORK: offerWork, ...noApps });
  const offerText = readFileSync(join(offerWork, "notes.md"), "utf8");
  check("the notes carry the source offer a binary distribution needs", offerText.includes("corresponding source"), true);
  check("and it names this tag rather than a branch", offerText.includes("/tree/v0.1.0"), true);
  check("and it follows SOURCE_URL rather than repository.url", 
    readFileSync(join((() => { const w = join(tmp("relfork-"), "w"); release("plan", { RELEASE_WORK: w, ...noApps }, fixture({ sourceUrl: "https://forge.example/fork/reemoat" })); return w; })(), "notes.md"), "utf8")
      .includes("https://forge.example/fork/reemoat/tree/v0.1.0"),
    true,
  );

  process.stdout.write("\nthe release script against the workflow that calls it\n");

  // Whole-line `#`, else the first whitespace-preceded `#` outside quotes, so a comment cannot satisfy a gate.
  // Biased toward removing too much, block scalars included: that direction reads as unbuilt, which is loud.
  const withoutComments = (yaml: string): string =>
    yaml
      .split("\n")
      .map((line) => {
        if (/^\s*#/.test(line)) return "";
        let quote: string | null = null;
        for (let i = 0; i < line.length; i += 1) {
          const c = line[i] as string;
          if (quote !== null) {
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === "#" && /\s/.test(line[i - 1] ?? " ")) {
            return line.slice(0, i).replace(/[ \t]+$/, "");
          }
        }
        return line;
      })
      .join("\n");

  check("a whole-line comment becomes nothing", withoutComments("      # - target: android"), "");
  check("a trailing comment goes", withoutComments("    runs-on: ubuntu-latest  # the only one"), "    runs-on: ubuntu-latest");
  check("a # inside a quoted scalar stays", withoutComments('    run: echo "a # b"'), '    run: echo "a # b"');
  check(
    "and so does a URL fragment, which YAML does not call a comment either",
    withoutComments("    url: https://example.invalid/x#y"),
    "    url: https://example.invalid/x#y",
  );

  const shellCode = (src: string): string =>
    src
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

  const releaseSh = readFileSync(join(repoRoot, "deploy", "ci-release.sh"), "utf8");
  const releaseCode = shellCode(releaseSh);
  const releaseYml = withoutComments(
    readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8"),
  );

  const verbArm = /case "\$verb" in\n[ \t]*([a-z][a-z |]*)\)[ \t]*;;/.exec(releaseCode);
  const verbs = (verbArm?.[1] ?? "")
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
  const invoked = [
    ...releaseYml.matchAll(/^[ \t]*run:[ \t]*deploy\/ci-release\.sh[ \t]+(\S+)[ \t]*$/gm),
  ].map((m) => m[1] as string);
  check("the script's verb list is readable at all", verbs.length > 0, true);
  check("and the workflow's calls are readable at all", invoked.length > 0, true);
  check("every verb the script accepts is invoked by a job", verbs.filter((v) => !invoked.includes(v)), []);
  check(
    "and every verb a job invokes is one the script accepts",
    [...new Set(invoked)].sort().filter((v) => !verbs.includes(v)),
    [],
  );

  check(
    "the app matrix is plan's output rather than a list written in YAML",
    /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.app_matrix\) \}\}/.test(releaseYml),
    true,
  );
  check(
    "and the job reading it is gated on there being a leg at all",
    releaseYml.includes("if: ${{ needs.plan.outputs.app_desktop != '' }}"),
    true,
  );
  check(
    "android is gated on its own flag, being a job rather than a leg",
    releaseYml.includes("if: ${{ needs.plan.outputs.app_android == '1' }}"),
    true,
  );
  check(
    "publish runs even when no app job did",
    releaseYml.includes("if: ${{ !cancelled() && needs.manifest.result == 'success' }}"),
    true,
  );

  // `manifest` creates the pullable tags, so it waits for every app job and never runs after one failed.
  const jobText = (yml: string, job: string): string => {
    const lines = yml.slice(yml.indexOf("\njobs:\n")).split("\n");
    const start = lines.findIndex((line) => line === `  ${job}:`);
    if (start < 0) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^  [a-z][a-z0-9-]*:[ \t]*$/.test(line));
    return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
  };
  const manifestJob = jobText(releaseYml, "manifest");
  check("the manifest job is readable at all", manifestJob !== "", true);
  const manifestNeeds = /^    needs:[ \t]*\[([^\]]*)\]/m.exec(manifestJob)?.[1]?.split(",").map((n) => n.trim()).sort() ?? [];
  check("manifest names nothing until the image and every app are built", manifestNeeds, ["app", "app-android", "image"]);
  const manifestIf = /^    if:[ \t]*(.*)$/m.exec(manifestJob)?.[1] ?? "";
  check(
    "and it runs only when each of them succeeded or was skipped by design",
    [
      manifestIf.includes("needs.image.result == 'success'"),
      manifestIf.includes("needs.app.result == 'success'"),
      manifestIf.includes("needs['app-android'].result == 'success'"),
      /needs\.app\.result == 'failure'|needs\['app-android'\]\.result == 'failure'/.test(manifestIf),
    ],
    [true, true, true, false],
  );

  const checkWorkflow = withoutComments(readFileSync(join(repoRoot, ".github", "workflows", "check.yml"), "utf8"));
  const depsAction = join(repoRoot, ".github", "actions", "linux-app-deps", "action.yml");
  const usesDeps = /^[ \t]*-[ \t]*uses:[ \t]*\.\/\.github\/actions\/linux-app-deps[ \t]*$/m;
  check("the Linux app dependencies are one action", existsSync(depsAction), true);
  check(
    "and it installs what the build demonstrably cannot do without",
    existsSync(depsAction) && /^[ \t]+libwebkit2gtk-4\.1-dev\b/m.test(withoutComments(readFileSync(depsAction, "utf8"))),
    true,
  );
  check(
    "which the release's app job and the check's native job both use",
    [usesDeps.test(jobText(releaseYml, "app")), usesDeps.test(jobText(checkWorkflow, "native"))],
    [true, true],
  );
  check(
    "and neither workflow installs a package list of its own beside it",
    [/apt-get/.test(releaseYml), /apt-get/.test(checkWorkflow)],
    [false, false],
  );

  // Job ids are the only two-space keys with no value under `jobs:`, which makes this split safe.
  const jobsBody = releaseYml.slice(releaseYml.indexOf("\njobs:\n")).split("\n");
  const jobOf = (needle: string): string => {
    let job = "";
    for (const line of jobsBody) {
      const head = /^  ([a-z][a-z0-9-]*):[ \t]*$/.exec(line);
      if (head) job = head[1] as string;
      if (line.includes(needle)) return job;
    }
    return "";
  };
  const secretLines = jobsBody.filter((line) => line.includes("secrets."));
  check(
    "the workflow reads exactly the four Android secrets",
    secretLines.map((line) => (/secrets\.(\w+)/.exec(line) ?? [])[1]).sort(),
    [
      "RELEASE_ANDROID_KEYSTORE",
      "RELEASE_ANDROID_KEYSTORE_PASSWORD",
      "RELEASE_ANDROID_KEY_ALIAS",
      "RELEASE_ANDROID_KEY_PASSWORD",
    ],
  );
  check(
    "and every one of them is read by the android job alone",
    [...new Set(secretLines.map((line) => jobOf(line)))],
    ["app-android"],
  );

  const planOutputs = (targets: string): Record<string, string> => {
    const run = release("plan", {
      RELEASE_WORK: join(tmp("relmx-"), "w"),
      RELEASE_APP_TARGETS: targets,
    });
    const out: Record<string, string> = {};
    for (const line of run.out.split("\n")) {
      const m = /^(app_[a-z_]+)=(.*)$/.exec(line);
      if (m) out[m[1] as string] = m[2] as string;
    }
    return out;
  };
  interface Leg {
    target: string;
    triple: string;
    runner: string;
  }
  const legs = (matrix: string | undefined): Leg[] =>
    (JSON.parse(matrix ?? '{"include":[]}') as { include: Leg[] }).include;

  const noTargets = planOutputs("");
  check("an empty target list plans an empty matrix and empty gates", noTargets, {
    app_targets: "",
    app_matrix: '{"include":[]}',
    app_desktop: "",
    app_android: "",
  });
  const two = planOutputs("linux-x64 windows-x64");
  check("and a list plans one leg per target, carrying the triple and the runner", legs(two["app_matrix"]), [
    { target: "linux-x64", triple: "x86_64-unknown-linux-gnu", runner: "ubuntu-latest" },
    { target: "windows-x64", triple: "x86_64-pc-windows-msvc", runner: "windows-latest" },
  ]);
  check("and the desktop gate names them", two["app_desktop"], "linux-x64 windows-x64");
  check("and announces no android when nothing asked for one", two["app_android"], "");
  const droidOnly = planOutputs("android");
  check("android alone plans no matrix leg", legs(droidOnly["app_matrix"]), []);
  check("and leaves the desktop gate shut while raising its own", [droidOnly["app_desktop"], droidOnly["app_android"]], ["", "1"]);
  const mixed = planOutputs("android macos-arm64");
  check("and beside a desktop target it is still not one of them", legs(mixed["app_matrix"]), [
    { target: "macos-arm64", triple: "aarch64-apple-darwin", runner: "macos-latest" },
  ]);
  check(
    "both macOS targets build on one runner",
    legs(planOutputs("macos-arm64 macos-x64")["app_matrix"]).map((leg) => leg.runner),
    ["macos-latest", "macos-latest"],
  );

  const known = (/^app_known="([^"]*)"$/m.exec(releaseCode)?.[1] ?? "").split(/\s+/).filter(Boolean);
  check("the table's known targets are readable at all", known.length > 0, true);
  const runnerBody = /^app_runner\(\) \{\n([\s\S]*?)^\}$/m.exec(releaseCode)?.[1] ?? "";
  check("the runner table was found to read", runnerBody.length > 0, true);
  check(
    "and it answers for every known target but android",
    known.filter((t) => t !== "android" && !new RegExp(`(^|[ |])${t}(?![\\w-])`, "m").test(runnerBody)),
    [],
  );
  check("and deliberately not for android", /(^|[ |])android(?![\w-])/m.test(runnerBody), false);

  const declaredLine = /^RELEASE_APP_TARGETS=\$\{RELEASE_APP_TARGETS-([^}]*)\}$/m.exec(releaseCode);
  check("the published target list is readable at all", declaredLine !== null, true);
  const declared = (declaredLine?.[1] ?? "").split(/\s+/).filter(Boolean);
  // Comment-stripped and line-anchored, so a comment or a URL fragment naming a target cannot satisfy the gate.
  const unbuilt = (targets: string[], workflow: string): string[] => {
    const code = withoutComments(workflow);
    return targets.filter(
      (target) => !new RegExp(`^[ \\t]*[-{ \\t]*target:[ \\t]*["']?${target}(?![\\w-])`, "m").test(code),
    );
  };
  const fakeWorkflow = "        include:\n          - target: linux-x64\n            runner: ubuntu-latest\n";
  check("a target with a check leg passes the comparison", unbuilt(["linux-x64"], fakeWorkflow), []);
  check("and one without it is named", unbuilt(["linux-x64", "android"], fakeWorkflow), ["android"]);
  check(
    "a target named only in a whole-line comment is still unbuilt",
    unbuilt(["android"], `${fakeWorkflow}          # - target: android\n`),
    ["android"],
  );
  check(
    "and one named only in a trailing comment is too",
    unbuilt(["android"], `${fakeWorkflow}          runner: ubuntu-latest  # - target: android\n`),
    ["android"],
  );
  check(
    "and one named only inside a URL is too",
    unbuilt(["android"], `${fakeWorkflow}          url: https://example.invalid/x#target:android\n`),
    ["android"],
  );
  const checkYml = readFileSync(join(repoRoot, ".github", "workflows", "check.yml"), "utf8");
  process.stdout.write(
    declared.length === 0
      ? "  note  RELEASE_APP_TARGETS is empty: no app is published until a check leg builds one\n"
      : `  note  published targets: ${declared.join(" ")}\n`,
  );
  check("every target this release publishes is built by a check.yml job", unbuilt(declared, checkYml), []);

  const SENTINEL = "ghp_deploycheckSentinelMustNotBePrinted";
  const withToken = release("plan", { GH_TOKEN: SENTINEL, RELEASE_WORK: join(tmp("reltok-"), "w") });
  check("a forge token in the environment is not printed", withToken.out.includes(SENTINEL) || withToken.err.includes(SENTINEL), false);
  check("and the run that proves it actually succeeded", withToken.status, 0);
  check("and it runs with no GITHUB_OUTPUT to write to", planned.status, 0);
}

process.stdout.write("\nwhat the freshness job does, driven without a registry\n");

// Seams: NPM_VIEW is the registry, FRESHNESS_ROOT the tree read, and only FRESHNESS_MAX_BEHIND makes behind a refusal.
{
  const freshHome = tmp("cifresh-");
  const freshBin = join(freshHome, "bin");
  mkdirSync(freshBin, { recursive: true });

  let stubSeq = 0;
  const stub = (body: string): string => {
    stubSeq += 1;
    const path = join(freshBin, `npm-${stubSeq}`);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const CLAUDE = "@agentclientprotocol/claude-agent-acp";
  const CODEX = "@agentclientprotocol/codex-acp";

  interface Answer {
    latest: string;
    versions: string[];
    deprecated?: string;
  }

  // Refuses any question it was not written for; keyed on `$1 $2` so one package's questions never share an arm.
  const registry = (answers: Record<string, Answer>): string => {
    const arms = Object.entries(answers)
      .map(
        ([pkg, a]) =>
          `  "${pkg} dist-tags.latest") echo "${a.latest}" ;;\n` +
          `  "${pkg} versions") printf '%s\\n' '[' ${a.versions.map((v) => `'  "${v}",'`).join(" ")} ']' ;;\n` +
          `  "${pkg}@"*" deprecated") ${a.deprecated === undefined ? ":" : `echo "${a.deprecated}"`} ;;\n`,
      )
      .join("");
    return stub(`case "$1 $2" in\n${arms}  *) echo "unexpected question: $*" >&2; exit 9 ;;\nesac`);
  };

  const manifest = (pins: Record<string, string>): string => {
    const dir = tmp("freshtree-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "reemoat",
          version: "0.1.0",
          devDependencies: { ...pins, "@agentclientprotocol/sdk": "1.3.0", tsx: "^4.0.0" },
        },
        null,
        2,
      ),
    );
    return dir;
  };

  const current = registry({
    [CLAUDE]: { latest: "0.63.0", versions: ["0.62.0", "0.63.0"] },
    [CODEX]: { latest: "1.1.9", versions: ["1.1.8", "1.1.9"] },
  });
  const moved = registry({
    [CLAUDE]: { latest: "0.73.0", versions: ["0.62.0", "0.63.0", "0.70.0", "0.73.0"] },
    [CODEX]: { latest: "1.1.9", versions: ["1.1.8", "1.1.9"] },
  });
  const pinned = (): string => manifest({ [CLAUDE]: "0.63.0", [CODEX]: "1.1.9" });

  const freshness = (env: Record<string, string> = {}, root: string = pinned(), ...args: string[]): Run => {
    const result = spawnSync("sh", [join(repoRoot, "deploy", "ci-freshness.sh"), ...args], {
      cwd: deployDir,
      encoding: "utf8",
      env: { PATH: baseEnv.PATH, HOME: freshHome, NPM_VIEW: current, FRESHNESS_ROOT: root, ...env },
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };

  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "freshness.yml"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));
  const runs = workflow.filter((line) => /^\s*run:/.test(line)).map((line) => line.trim());
  check("freshness.yml runs the script and nothing else", runs, ["run: deploy/ci-freshness.sh"]);
  check("and holds no condition of its own", workflow.filter((line) => /^\s*if:/.test(line)), []);
  check("and fires on a schedule and a button, never on a push", [
    workflow.some((line) => /^\s*schedule:/.test(line)),
    workflow.some((line) => /^\s*workflow_dispatch:/.test(line)),
    workflow.some((line) => /^\s*(push|pull_request):/.test(line)),
  ], [true, true, false]);
  check("and can write nothing back", workflow.filter((line) => /^\s+\w[\w-]*:\s*write\b/.test(line)), []);
  check("and reads no secret", workflow.some((line) => line.includes("secrets.")), false);

  const realManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const realPins = Object.entries({ ...realManifest.dependencies, ...realManifest.devDependencies }).filter(([name]) =>
    /^@agentclientprotocol\/.+-acp$/.test(name),
  );
  check("the real manifest pins the two adapters pincheck names", realPins.map(([name]) => name).sort(), [CLAUDE, CODEX]);
  const onReal = freshness(
    { NPM_VIEW: registry(Object.fromEntries(realPins.map(([name, v]) => [name, { latest: v, versions: [v] }]))) },
    repoRoot,
  );
  check("against the real tree it names each adapter at the version package.json carries", [
    onReal.status,
    realPins.filter(([name, v]) => !onReal.out.includes(`${name}: ${v} is current`)),
  ], [0, []]);
  const movedPin = freshness({}, manifest({ [CLAUDE]: "0.62.0", [CODEX]: "1.1.9" }));
  check("and a fixture whose pin moved moves the report", movedPin.out.includes(`${CLAUDE}: 0.62.0 is behind by 1 release(s); latest is 0.63.0`), true);

  const green = freshness();
  check("two current pins exit 0", green.status, 0);
  check("naming each as current", [green.out.includes(`${CLAUDE}: 0.63.0 is current`), green.out.includes(`${CODEX}: 1.1.9 is current`)], [true, true]);

  const summaryFile = join(tmp("freshsum-"), "summary.md");
  const behind = freshness({ NPM_VIEW: moved, GITHUB_STEP_SUMMARY: summaryFile });
  check("a pin behind latest still exits 0", behind.status, 0);
  check("and says by how many releases, and what latest is", behind.out.includes(`${CLAUDE}: 0.63.0 is behind by 2 release(s); latest is 0.73.0`), true);
  const summary = readFileSync(summaryFile, "utf8");
  check("the job summary carries a row per adapter", [
    /\| `@agentclientprotocol\/claude-agent-acp` \| 0\.63\.0 \| 0\.73\.0 \| behind by 2 release\(s\) \|/.test(summary),
    /\| `@agentclientprotocol\/codex-acp` \| 1\.1\.9 \| 1\.1\.9 \| current \|/.test(summary),
  ], [true, true]);
  check("and no summary is written where there is none to write", existsSync(join(freshHome, "summary.md")), false);

  const overMargin = freshness({ NPM_VIEW: moved, FRESHNESS_MAX_BEHIND: "1" });
  check("behind by more than FRESHNESS_MAX_BEHIND is refused", overMargin.status, 2);
  check("naming the variable", overMargin.err.includes("FRESHNESS_MAX_BEHIND"), true);
  check("while behind by exactly the margin is not", freshness({ NPM_VIEW: moved, FRESHNESS_MAX_BEHIND: "2" }).status, 0);
  check("and a margin that is not a count is refused before the registry is asked", freshness({ FRESHNESS_MAX_BEHIND: "lots" }).status, 2);

  const deprecated = freshness({
    NPM_VIEW: registry({
      [CLAUDE]: { latest: "0.63.0", versions: ["0.63.0"], deprecated: "use 0.73.0" },
      [CODEX]: { latest: "1.1.9", versions: ["1.1.9"] },
    }),
  });
  check("a deprecated pin exits 0", deprecated.status, 0);
  check("and is reported with the registry's own message", deprecated.out.includes("deprecated: use 0.73.0"), true);

  const gone = freshness({
    NPM_VIEW: registry({
      [CLAUDE]: { latest: "0.73.0", versions: ["0.62.0", "0.73.0"] },
      [CODEX]: { latest: "1.1.9", versions: ["1.1.9"] },
    }),
    GITHUB_STEP_SUMMARY: join(tmp("freshgone-"), "summary.md"),
  });
  check("a pin the registry no longer lists is refused", gone.status, 2);
  check("naming the package and version", gone.err.includes(`${CLAUDE}@0.63.0`), true);
  check("and saying what it breaks", gone.err.includes("frozen-lockfile"), true);
  check("with the other adapter still reported", gone.out.includes(`${CODEX}: 1.1.9 is current`), true);
  const prefix = freshness({ NPM_VIEW: registry({ [CLAUDE]: { latest: "0.63.0", versions: ["0.63.0"] }, [CODEX]: { latest: "1.1.9", versions: ["1.1.9"] } }) }, manifest({ [CLAUDE]: "0.6.0", [CODEX]: "1.1.9" }));
  check("a pin that is a prefix of a published version is not thereby published", prefix.status, 2);

  const down = freshness({ NPM_VIEW: stub(`echo "npm ERR! code ENOTFOUND registry.npmjs.org" >&2; exit 1`) });
  check("a registry that cannot be asked exits 3, not 2", down.status, 3);
  check("with a sentence saying it is about the run", down.err.includes("could not ask the registry"), true);
  check("carrying npm's own reason", down.err.includes("ENOTFOUND"), true);
  check("and never the word refusing, which is a verdict", down.err.includes("refusing"), false);
  const silent = freshness({ NPM_VIEW: stub(`case "$2" in dist-tags.latest) ;; versions) echo '["0.63.0"]' ;; deprecated) ;; esac`) });
  check("a registry that answers no latest at all is unreachable too", silent.status, 3);

  const noPins = freshness({ NPM_VIEW: stub(`exit 9`) }, manifest({}));
  check("a manifest with no adapter pin is refused rather than reported green", noPins.status, 2);
  check("and says the pattern is what to fix", noPins.err.includes("pattern"), true);
  const ranged = freshness({ NPM_VIEW: stub(`exit 9`) }, manifest({ [CLAUDE]: "^0.63.0", [CODEX]: "1.1.9" }));
  check("a range is refused as not a pin", ranged.status, 2);
  check("naming the package", ranged.err.includes(CLAUDE) && ranged.err.includes("range"), true);
  check("a tree with no manifest is refused", freshness({ NPM_VIEW: stub(`exit 9`) }, tmp("freshempty-")).status, 2);
  check("and an argument is a usage error, since there are none", freshness({}, pinned(), "--check").status, 2);

  const SENTINEL = "npm_deploycheckSentinelMustNotBePrinted";
  const withToken = freshness({ NPM_TOKEN: SENTINEL, NODE_AUTH_TOKEN: SENTINEL });
  check("a registry token in the environment is not printed", withToken.out.includes(SENTINEL) || withToken.err.includes(SENTINEL), false);
  check("and that run succeeded", withToken.status, 0);
}

process.stdout.write("\nwhat the control plane's migration is allowed to do\n");
{
  const storeSource = readFileSync(join(repoRoot, "packages/control-plane/src/store.ts"), "utf8");

  const marker = "function migrate(db: DatabaseSync): void {";
  const from = storeSource.indexOf(marker);
  check("migrate() is where this check believes it is", from !== -1, true);

  let depth = 0;
  let end = from;
  for (let i = from + marker.length - 1; i < storeSource.length; i += 1) {
    const ch = storeSource[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = storeSource.slice(from, end + 1);
  check("and its body was read, rather than silently coming back empty", body.length > marker.length, true);

  // Matched on the SQL literal, not the call around it, so a statement moved into a helper stays covered.
  const statements = [...body.matchAll(/"([A-Z]+ [^"]*)"/g)].map((m) => m[1] ?? "");
  check("the migration names some SQL at all", statements.length > 0, true);
  // CREATE INDEX IF NOT EXISTS is allowed for an index on a column this function adds, which schema.sql (run first) cannot hold.
  check(
    "and every statement it names is a read, an ADD COLUMN, or an idempotent index",
    statements.filter(
      (sql) =>
        !/^ALTER TABLE \w+ ADD COLUMN /.test(sql) &&
        !/^PRAGMA \w+\(/.test(sql) &&
        !/^CREATE INDEX IF NOT EXISTS \w+ ON \w+ \(/.test(sql),
    ),
    [],
  );
  const helperStart = storeSource.indexOf("function addColumn(");
  const helper = storeSource.slice(helperStart, storeSource.indexOf("\n}\n", helperStart));
  check("the helper executes only the statement it was given", /db\.exec\(\s*"/.test(helper), false);
  check(
    "with no DROP and no RENAME anywhere in it",
    /\b(DROP|RENAME)\b/i.test(body),
    false,
  );

  // A literal on purpose: read from the file it guards, this check would agree with whatever it found.
  const declared = /export const CP_SCHEMA_VERSION = (\d+)/.exec(storeSource);
  check("CP_SCHEMA_VERSION is readable", declared !== null, true);
  check(
    "and has not moved, because an addition is invisible to an older build and must stay so",
    Number(declared?.[1] ?? -1),
    1,
  );
}

process.stdout.write("\nthe backup\n");

{
  const backup = join(deployDir, "backup.sh");
  check("there is a backup script at all", existsSync(backup), true);
  check("and it is executable", (statSync(backup).mode & 0o111) !== 0, true);

  const text = readFileSync(backup, "utf8");
  check("it takes SQLite's own consistent snapshot", text.includes("VACUUM INTO"), true);
  check("and never tars or copies the volume out from under a live writer", /\bcp -r|tar .*var\/lib\/reemoat/.test(text), false);
  check("every snapshot is verified before it counts as one", text.includes("integrity_check"), true);
  check("and kept at 0600, like the database it came from", text.includes('chmod 600 "$OUT.part"'), true);
  check(
    "retention only ever names files this script wrote",
    text.includes('"$DIR"/control-plane-*.db') && !/rm -f "\$DIR"\/\*/.test(text),
    true,
  );

  const run = (args: string): { status: number; err: string } => {
    const result = spawnSync("sh", [backup, ...args.split(" ").filter((part) => part.length > 0)], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: process.env["PATH"] ?? "" },
    });
    return { status: result.status ?? -1, err: `${result.stderr}${result.stdout}` };
  };

  const badKeep = run("--keep never");
  check("a retention count that is not a number is refused", badKeep.status, 2);
  check("naming what was actually typed", badKeep.err.includes("never"), true);
  check("and an unknown flag is refused rather than ignored", run("--nope").status, 2);
  check("with nothing created on the way to the refusal", existsSync(join(home, ".reemoat", "backups")), false);
}

process.stdout.write("\nbuilt here, or pulled\n");

{
  const cpEnv = join(home, ".reemoat", "control-plane.env");
  mkdirSync(dirname(cpEnv), { recursive: true });

  const ref = (env: Record<string, string> = {}): string => sh('printf "%s" "$(cp_image_ref)"', env).out;
  const source = (env: Record<string, string> = {}): string => sh('printf "%s" "$(cp_image_source)"', env).out;

  check("with nothing set, the local build tag", ref(), "reemoat/control-plane:current");
  check("which means this host builds", source(), "build");
  check("the environment wins when it speaks", ref({ REEMOAT_CP_IMAGE: "ghcr.io/x/y:v1" }), "ghcr.io/x/y:v1");
  check("and a registry-qualified ref means pull", source({ REEMOAT_CP_IMAGE: "ghcr.io/x/y:v1" }), "pull");
  check("a port counts as a registry too", source({ REEMOAT_CP_IMAGE: "localhost:5000/y:v1" }), "pull");
  check("a bare name does not", source({ REEMOAT_CP_IMAGE: "someone/control-plane:v1" }), "build");

  writeFileSync(cpEnv, "REEMOAT_CP_IMAGE='ghcr.io/rends-east/reemoat/control-plane:v0.4.0'\n", { mode: 0o600 });
  check("the env file is read when the environment is silent", ref(), "ghcr.io/rends-east/reemoat/control-plane:v0.4.0");
  check("and that is enough to put the host in pull mode", source(), "pull");
  check("but the environment still wins over it", ref({ REEMOAT_CP_IMAGE: "reemoat/control-plane:current" }), "reemoat/control-plane:current");

  const bad = sh("cp_image_source", { REEMOAT_CP_SOURCE: "nonsense" });
  check("an unknown REEMOAT_CP_SOURCE is refused", bad.status, 2);
  check("naming what was typed", bad.err.includes("nonsense"), true);
  check("and the override is honoured when it is one of the two", source({ REEMOAT_CP_IMAGE: "ghcr.io/x/y:v1", REEMOAT_CP_SOURCE: "build" }), "build");

  const composeSource = readFileSync(join(deployDir, "compose.sh"), "utf8");
  const deploySource = readFileSync(join(deployDir, "deploy.sh"), "utf8");
  const codeOf = (src: string): string =>
    src.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  check(
    "no script writes the image default out for itself",
    [codeOf(composeSource), codeOf(deploySource)].map((src) => /reemoat\/control-plane:current/.test(src)),
    [false, false],
  );
  check(
    "and both reach it through the resolver",
    [/cp_image_ref/.test(codeOf(composeSource)), /cp_image_source/.test(codeOf(deploySource))],
    [true, true],
  );
  check(
    "including the fingerprint the relay recreate decision reads",
    /cp_image_fingerprint\(\)[\s\S]{0,400}cp_image_ref/.test(readFileSync(join(deployDir, "lib.sh"), "utf8")),
    true,
  );
  check(
    "and lib.sh itself writes the default once, in the resolver",
    codeOf(readFileSync(join(deployDir, "lib.sh"), "utf8")).match(/reemoat\/control-plane:current/g)?.length,
    1,
  );

  // Answers with the image name it was asked about, so what each function inspects is the output.
  const inspected = join(tmp("cpimage-"), "docker");
  writeFileSync(inspected, '#!/bin/sh\nfor a in "$@"; do last=$a; done\nprintf \'%s\' "$last"\n');
  chmodSync(inspected, 0o755);
  const asks = (fn: string): string => sh(`printf "%s" "$(${fn})"`, { REEMOAT_DOCKER: inspected }).out;
  check(
    "the id install.sh prints is of the image the fingerprint reads, when only the env file names it",
    [asks("cp_image_id"), asks("cp_image_fingerprint")],
    ["ghcr.io/rends-east/reemoat/control-plane:v0.4.0", "ghcr.io/rends-east/reemoat/control-plane:v0.4.0"],
  );

  rmSync(cpEnv, { force: true });
}

process.stdout.write("\nthe one-line installer\n");

{
  const bootstrapPath = join(deployDir, "bootstrap.sh");
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const bootstrapLines = bootstrap.split("\n");
  // A full-line `#` is the only comment form bootstrap.sh uses.
  const code = bootstrapLines.filter((line) => !/^\s*#/.test(line)).join("\n");

  // `detached` is load-bearing: the child leads its own session, so `/dev/tty` cannot open and no prompt reaches a developer's terminal.
  const runBootstrap = (args: string[], env: Record<string, string> = {}): Run => {
    // A variable, not a literal: `detached` is honoured but missing from SpawnSyncOptions, so a literal fails the excess-property check.
    const options = {
      cwd: deployDir,
      encoding: "utf8" as const,
      env: { ...baseEnv, HOME: home, ...env },
      detached: true,
      // stdin closed, which is also the `curl | sh` shape.
      input: "",
    };
    const run = spawnSync("sh", [bootstrapPath, ...args], options);
    return { status: run.status ?? -1, out: run.stdout ?? "", err: run.stderr ?? "" };
  };

  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    packageManager: string;
    engines: { node: string };
  };
  const pinned = (name: string): string =>
    /^\s*([^\s=]+)\s*$/.exec(
      lineIn("bootstrap.sh", bootstrapLines, `${name}`, `${name}=`).slice(name.length + 1),
    )?.[1] ?? "";
  check(
    "the pnpm it installs is the one the lockfile was written by",
    `pnpm@${pinned("PNPM_VERSION")}`,
    rootManifest.packageManager,
  );
  const engineMajor = Number.parseInt(rootManifest.engines.node.replace(/[^\d.]/g, ""), 10);
  check(
    "and the node it installs satisfies engines.node",
    Number.parseInt(pinned("NODE_MAJOR"), 10) >= engineMajor,
    true,
  );

  const urls = [...code.matchAll(/https:\/\/[^\s"'`$)\\]+/g)].map((m) => m[0]);
  const hosts = urls.filter((u) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i.test(u));
  const namesHost = (line: string): boolean =>
    !/^\s*#/.test(line) &&
    // Anchored on the scheme and an alphanumeric authority, so placeholders and `$CP/…` name no host.
    /https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(line) &&
    !/nodejs\.org/.test(line);

  const resolveBody = blockIn(
    "bootstrap.sh",
    bootstrapLines,
    "resolve_control_plane",
    "resolve_control_plane() {",
    "}",
  ).split("\n");
  check(
    "the only lines naming a control-plane host are in resolve_control_plane",
    bootstrapLines.filter(namesHost).filter((l) => !resolveBody.includes(l)),
    [],
  );
  const menuLine = resolveBody.find((l) => /\bmenu\b/.test(l) && /app\.reemoat\.com/.test(l)) ?? "";
  const optionsAfter = menuLine.slice(menuLine.indexOf("menu "));
  // Enter takes the first row, so the hosted instance must never be first.
  check("the hosted instance is offered, and never first", /"My own"[\s\S]*app\.reemoat\.com/.test(optionsAfter), true);
  check(
    "and it is assigned only behind that menu's answer",
    /= 2 \]; then\s*$/.test(menuLine.trim()) &&
      namesHost(resolveBody[resolveBody.indexOf(menuLine) + 1] ?? ""),
    true,
  );
  check(
    "while the toolchain download still is",
    hosts.some((u) => u.startsWith("https://nodejs.org/")),
    true,
  );
  check(
    "and the hosted one is named to the reader, in prose",
    bootstrapLines.some((l) => !/^\s*#/.test(l) && /app\.reemoat\.com/.test(l)),
    true,
  );

  const appSource = readFileSync(join(repoRoot, "packages/control-plane/src/app.ts"), "utf8");
  const placeholder = /^const INSTALL_PLACEHOLDER = "([^"]+)";$/m.exec(appSource)?.[1] ?? "";
  check("app.ts declares the placeholder as a plain literal", placeholder.length > 0, true);
  check(
    "and bootstrap.sh reserves it exactly once",
    bootstrap.split(placeholder).length - 1,
    1,
  );

  {
    const run = runBootstrap([]);
    check("an unsubstituted script refuses", run.status, 2);
    check("and says how to name a control plane", run.err.includes("--url"), true);
    check("without a shell error above it", /\/dev\/tty/.test(run.err), false);
  }

  for (const flag of ["--url", "--api-key", "--enroll-code", "--label", "--dir", "--ref", "--node", "--agent-source", "--agent-channel"]) {
    const run = spawnSync("sh", [bootstrapPath, flag], {
      cwd: deployDir,
      encoding: "utf8",
      env: { ...baseEnv, HOME: home },
      input: "",
    });
    check(`${flag} with no value is refused by name`, run.stderr.includes(`${flag} needs a value`), true);
    check("without installing anything on the way", existsSync(join(home, ".reemoat", "toolchain")), false);
  }

  {
    const bad = runBootstrap(["--agent-source", "bogus"]);
    check("--agent-source with a value it does not know is refused by name", [bad.status, bad.err.includes("--agent-source takes vendor or npm, not bogus")], [2, true]);
    check("without installing anything on the way", existsSync(join(home, ".reemoat", "toolchain")), false);
    const good = runBootstrap(["--agent-source", "npm"]);
    check("while npm passes the parser and fails on the control plane instead", [good.status, good.err.includes("--url"), good.err.includes("--agent-source")], [2, true, false]);
    const badChannel = runBootstrap(["--agent-channel", "nightly"]);
    check("--agent-channel with a value it does not know is refused by name", [badChannel.status, badChannel.err.includes("--agent-channel takes stable or latest, not nightly")], [2, true]);
    check("without installing anything on the way", existsSync(join(home, ".reemoat", "toolchain")), false);
    const goodChannel = runBootstrap(["--agent-channel", "stable"]);
    check("while stable passes the parser and fails on the control plane instead", [goodChannel.status, goodChannel.err.includes("--url"), goodChannel.err.includes("--agent-channel")], [2, true, false]);

    for (const nameless of [",,,", ",", ""]) {
      const run = runBootstrap(["--install-agents", nameless]);
      check(
        `--install-agents ${JSON.stringify(nameless)} names no harness and is refused by name`,
        [run.status, run.err.includes(`--install-agents names no agent in "${nameless}"`), run.err.includes("omit the flag to install none")],
        [2, true, true],
      );
    }
    const named = runBootstrap(["--install-agents", "claude,codex"]);
    check("while a list that names two passes the parser and fails on the control plane instead", [named.status, named.err.includes("--url"), named.err.includes("--install-agents")], [2, true, false]);
    const stray = runBootstrap(["--install-agents", "claude,,codex"]);
    check("and a separator between two names is not a nameless list", [stray.status, stray.err.includes("--install-agents")], [2, false]);
    // `LC_ALL=C` pinned: `[!a-z,]` is a range, and under a UTF-8 locale uppercase collates inside a–z.
    const badShape = runBootstrap(["--install-agents", "Claude"], { LC_ALL: "C" });
    check("while a name outside the shape is still refused by the shape, naming it", [badShape.status, badShape.err.includes("--install-agents takes a comma-separated list of agent names, not Claude")], [2, true]);
    check("and no harness was installed on the way to any of those", existsSync(join(home, ".reemoat", "toolchain")), false);
  }

  {
    const copyAt = bootstrapLines.indexOf('API_KEY="${REEMOAT_API_KEY:-}"');
    check("the API key is copied out of the environment once", copyAt !== -1, true);
    check("and the next line takes it out of the environment", bootstrapLines[copyAt + 1], "unset REEMOAT_API_KEY");
    check(
      "with nothing after it reading the name",
      bootstrapLines.slice(copyAt + 2).filter((line) => !/^\s*#/.test(line) && /\$\{?REEMOAT_API_KEY/.test(line)),
      [],
    );
  }

  {
    const originRefusal = (url: string): Run => runBootstrap(["--url", url, "--api-key", "rk_x", "--yes"]);
    for (const bad of ["https://cp.example/v1", "https://a:b@cp.example", "https://cp.example?x", "https://cp.example#f", "ftp://cp.example"]) {
      const run = originRefusal(bad);
      check(`${bad} is refused as an origin, naming it`, [run.status, run.err.includes("--url must be an http(s) origin, not"), run.err.includes(bad)], [2, true, true]);
    }
    const control = originRefusal("https://cp.example/");
    check("while an origin with a trailing slash gets past that check", [control.status !== 0, control.err.includes("--url must be an http(s) origin")], [true, false]);
  }

  {
    const bodySource = blockIn("bootstrap.sh", bootstrapLines, "credential_body", "credential_body() {", "}");
    const body = (...args: string[]): unknown => {
      const run = spawnSync("sh", ["-c", `${bodySource}\ncredential_body "$@"`, "sh", ...args], {
        encoding: "utf8",
        env: { ...baseEnv, NODE_BIN: process.execPath },
      });
      try {
        return JSON.parse(run.stdout);
      } catch {
        // Not JSON at all is the finding, and the raw text is what says why.
        return `not JSON: ${run.stdout}${run.stderr}`;
      }
    };
    const password = `p"a\\b'c\n$(x)é`;
    check("credential_body carries a hostile password intact, with no email key", body("alice", password), { name: "alice", password });
    check("and adds email only when one was given", body("alice", password, "a@example.test"), { name: "alice", password, email: "a@example.test" });
  }

  // `curl | sh` runs a truncated download's prefix, so everything sits in functions called from the last line.
  const nonEmpty = bootstrapLines.filter((line) => line.trim().length > 0);
  check("everything runs from one call on the last line", nonEmpty.at(-1), 'main "$@"');
  // `/^main /` rather than a word boundary, which would also match the declaration.
  check(
    "and nothing else calls it",
    bootstrapLines.filter((line) => /^main /.test(line)).length,
    1,
  );

  {
    const machines = readFileSync(join(repoRoot, "packages/control-plane/src/machines.ts"), "utf8");
    const readRe = (name: string): RegExp => {
      const found = new RegExp(`^export const ${name} = /(.+)/;$`, "m").exec(machines)?.[1];
      if (found === undefined) {
        failures += 1;
        process.stdout.write(`  FAIL  machines.ts no longer declares ${name} as a plain literal\n`);
        return /(?!)/;
      }
      return new RegExp(found);
    };
    const label = readRe("MACHINE_LABEL");
    const reserved = readRe("MACHINE_LABEL_RESERVED");
    // Extracted and run, never sourced: sourcing bootstrap.sh runs the whole installer.
    const sanitizeSource = blockIn("bootstrap.sh", bootstrapLines, "sanitize_label", "sanitize_label() {", "}");
    const sanitize = (input: string): string =>
      spawnSync("sh", ["-c", `${sanitizeSource}\nsanitize_label "$1"`, "sh", input], {
        encoding: "utf8",
        env: baseEnv,
      }).stdout ?? "";
    for (const input of [
      "MacBook-Pro.local",
      "m_ab12cd34",
      "m_0123456789abcdef",
      "-leading-dash",
      "Ünicode Näme",
      "x".repeat(90),
      "",
      "...",
    ]) {
      const out = sanitize(input);
      check(`${JSON.stringify(input)} sanitizes to a label the route accepts`, label.test(out), true);
      check(`and one it does not read as a machine id`, reserved.test(out), false);
    }
    const labelRefusal = (value: string): { status: number; err: string } =>
      runBootstrap(["--url", "http://127.0.0.1:1", "--api-key", "rk_x", "--yes", "--label", value]);
    for (const bad of ["MacBook Pro.local", "-leading", "m_ab12cd34", "m_0123456789abcdef", "Ünicode"]) {
      check(`${JSON.stringify(bad)} is refused, and by name`, label.test(bad) && !reserved.test(bad), false);
      const out = labelRefusal(bad);
      check(`and the script says so before it asks anything`, [out.status, out.err.includes(bad)], [2, true]);
    }
    check(
      "while a name the route accepts is not refused here",
      labelRefusal("laptop").err.includes("machine name"),
      false,
    );

    check(
      "and the inputs were ones the route would have refused",
      ["m_ab12cd34", "-leading-dash", "Ünicode Näme", ""].filter((raw) => label.test(raw) && !reserved.test(raw)),
      [],
    );
  }

  {
    interface Fixture {
      home: string;
      toolchain: string;
      checkout: string;
      db: string;
    }
    const fixture = (name: string, opts: { lib: boolean; worktree: boolean; env?: boolean; servers?: boolean }): Fixture => {
      const h = join(sandbox, `uninstall-${name}`);
      rmSync(h, { recursive: true, force: true });
      mkdirSync(join(h, ".reemoat", "toolchain", "bin"), { recursive: true });
      writeFileSync(join(h, ".reemoat", "toolchain", ".installed-by-bootstrap"), "");
      writeFileSync(join(h, ".reemoat", "reemoat.db"), "");
      // The env file is what do_uninstall reads as evidence the install reached the service.
      if (opts.env !== false) writeFileSync(join(h, ".reemoat", "daemon.env"), "REEMOAT_CONTROL_PLANE='https://cp.example'\n");
      mkdirSync(join(h, "co"), { recursive: true });
      if (opts.lib) {
        mkdirSync(join(h, "co", "deploy"), { recursive: true });
        writeFileSync(join(h, "co", "deploy", "lib.sh"), "svc_uninstall() { return 0; }\n");
      }
      if (opts.worktree) mkdirSync(join(h, ".reemoat", "worktrees", "branch-a"), { recursive: true });
      // A second server's daemon as the desktop app lays one out (Q7.148).
      if (opts.servers === true) {
        mkdirSync(join(h, ".reemoat", "servers", "https_other.example"), { recursive: true });
        writeFileSync(join(h, ".reemoat", "servers", "https_other.example", "reemoat.db"), "");
      }
      return {
        home: h,
        toolchain: join(h, ".reemoat", "toolchain"),
        checkout: join(h, "co"),
        db: join(h, ".reemoat", "reemoat.db"),
      };
    };
    const uninstall = (f: Fixture, ...args: string[]): Run =>
      runBootstrap(["--dir", f.checkout, "--uninstall", ...args], { HOME: f.home });

    {
      const f = fixture("no-lib", { lib: false, worktree: false });
      const run = uninstall(f);
      check("an uninstall that could not stop the service leaves the toolchain", existsSync(f.toolchain), true);
      check("and does not report success", run.status !== 0, true);
      check("and says which checkout would have worked", run.err.includes(f.checkout), true);
    }
    {
      const f = fixture("never-installed", { lib: false, worktree: false, env: false });
      const run = uninstall(f);
      check(
        "an uninstall with no checkout and no env file removes the toolchain and exits 0",
        [run.status, existsSync(f.toolchain), run.out.includes("nothing to stop"), run.err.includes("Re-run with --dir")],
        [0, false, true, false],
      );
      check("with the data left alone", existsSync(f.db), true);
    }
    {
      const f = fixture("with-lib", { lib: true, worktree: false });
      const run = uninstall(f);
      check("while a confirmed stop does remove it", existsSync(f.toolchain), false);
      check("and reports success", run.status, 0);
      check("with the data left alone, because that is what --uninstall promises", existsSync(f.db), true);
    }
    {
      const f = fixture("purge-empty", { lib: true, worktree: false });
      const run = uninstall(f, "--purge");
      check("--purge with no worktrees still asks", run.status !== 0, true);
      check("and takes nothing when it cannot ask", [existsSync(f.db), existsSync(f.checkout)], [true, true]);
      check("having named what it was about to take", run.err.includes("reemoat.db"), true);
    }
    {
      const f = fixture("purge-yes", { lib: true, worktree: false });
      const run = uninstall(f, "--purge", "--yes");
      check("--yes purges", [run.status, existsSync(f.db), existsSync(f.checkout)], [0, false, false]);
    }
    {
      const f = fixture("purge-tree", { lib: true, worktree: true });
      const copy = join(f.home, ".reemoat", "worktrees", "branch-a");
      const run = uninstall(f, "--purge");
      check("--purge names the working copies it would take", run.err.includes("branch-a"), true);
      check("and takes none of them without an answer", [run.status !== 0, existsSync(copy)], [true, true]);
      const g = fixture("purge-tree-yes", { lib: true, worktree: true });
      const yes = uninstall(g, "--purge", "--yes");
      check("while --yes takes them with everything else", [yes.status, existsSync(join(g.home, ".reemoat", "worktrees", "branch-a"))], [0, false]);
    }
    {
      const f = fixture("purge-servers", { lib: true, worktree: false, servers: true });
      const other = join(f.home, ".reemoat", "servers", "https_other.example");
      const run = uninstall(f, "--purge");
      check("--purge names the desktop app's other servers", run.err.includes("https_other.example"), true);
      check("and says to quit the app that may be running them", run.err.includes("Quit Reemoat first: it may be running these right now."), true);
      check("and takes none of them without an answer", [run.status !== 0, existsSync(other)], [true, true]);
      const g = fixture("purge-servers-yes", { lib: true, worktree: false, servers: true });
      const yes = uninstall(g, "--purge", "--yes");
      check("while --yes takes them with the rest", [yes.status, existsSync(join(g.home, ".reemoat", "servers"))], [0, false]);
      const h = fixture("keep-servers", { lib: true, worktree: false, servers: true });
      const kept = uninstall(h);
      check(
        "and a plain --uninstall keeps them and says where they are",
        [kept.status, existsSync(join(h.home, ".reemoat", "servers", "https_other.example")), kept.out.includes(".reemoat/servers")],
        [0, true, true],
      );
      const i = fixture("keep-no-servers", { lib: true, worktree: false });
      check("with nothing named when there are none", uninstall(i).out.includes(".reemoat/servers"), false);
      const j = fixture("purge-no-servers", { lib: true, worktree: false });
      check("and a purge with none says nothing about the app", uninstall(j, "--purge").err.includes("Quit Reemoat first"), false);
    }
  }
}

process.stdout.write("\ntaking a service away again\n");

{
  const refused = sh('svc_uninstall control-plane');
  check("uninstalling a container is refused", refused.status !== 0, true);
  check("and says what to run instead", refused.err.includes("compose.sh down"), true);
  check("naming no unit, because there is none", refused.err.includes("LaunchAgents"), false);
}

process.stdout.write("\nwhat this driver left behind\n");

check("no unit was installed where launchd would find one", existsSync(join(home, "Library/LaunchAgents")), false);
check("nor where systemd would", existsSync(join(home, ".config/systemd/user")), false);
check("and nothing was dropped in the repository", existsSync(join(deployDir, "PWNED")), false);

check("deploy/ is exactly as this run found it", deployState(), deployBefore);

process.stdout.write(failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
