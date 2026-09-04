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
import { tmp } from "./tmp.js";

/**
 * The regression driver for `deploy/`.
 *
 * Sixth of its kind, and the one that closes the largest hole any of them had.
 * `scripts/imagecheck.ts` says so in its own header — "nothing about launchd,
 * systemd, `render_unit`, the interview or `deploy.sh`'s gating — the parts of
 * `deploy/` most likely to be wrong stay unchecked" — and until this existed
 * that was 3116 lines of shell whose only proof was somebody running it. Every
 * measurement written into `deploy/lib.sh`'s comments was taken once, by hand,
 * on one machine; this is what makes them assertions instead.
 *
 * `sq` is why it is worth having rather than tidy to have. Those environment
 * files are `.`-sourced by `run-daemon.sh`, so an unquoted value is shell source
 * rather than data, and the ceiling is arbitrary code as the daemon that runs
 * your agents. The documented measurement — `REEMOAT_ENROLL_CODE=xy$(touch
 * PWNED)` creating the file on source — is driven below, both directions.
 *
 * **How it reaches the shell.** `lib.sh` derives `DEPLOY_DIR` from `$0`, so it
 * cannot be sourced from an arbitrary path. Under `sh -c` the `$0` is `sh`,
 * whose `dirname` is `.` — so spawning with `cwd` set to `deploy/` resolves both
 * `DEPLOY_DIR` and `REPO_ROOT` correctly, and no shim has to be committed beside
 * the thing being tested. Measured; the alternative was a second file in
 * `deploy/` existing only for this.
 *
 * **The environment is built rather than inherited**, and that is not tidiness
 * either. `unit_target` returns `$HOME/Library/LaunchAgents/<label>.plist`, and
 * `install.sh` documents that rendering there arms a ten-second crash loop at
 * the next reboot — so a driver that ran with the operator's real `HOME` would
 * install a unit as a side effect of being green. Every case runs against a
 * `tmp()` home, and `render_unit` is called with the target override that
 * exists for exactly this.
 *
 * What a green run does **not** earn, said here in the house style so nobody
 * reads more into it: nothing about a real launchd or systemd, nothing about
 * `install.sh`'s interview end to end, and nothing about `deploy.sh`'s
 * `git reset --hard` path. Those touch a supervisor and the checkout, and a
 * driver that drove them would be doing the thing it is testing.
 *
 * What *is* covered is named rather than claimed, because "every function whose
 * answer is derivable" is the kind of sentence that is true the day it is written
 * and quietly false a function later: `sq`, `set_env`, `file_value`, `env_value`,
 * `valid_service`, `service_backend`, `service_exec`, `unit_label`, `unit_target`,
 * `unit_template`, `log_dir`, `env_file`, `env_example`, `resolve_bin`,
 * `runtime_path`, `esc_sed`, `esc_xml`, `subst_value`, `render_unit`,
 * `json_field`, `service_origin`, `health_probe_target`, `health_probe_path` and
 * `compose_service`. What is left is the
 * half that needs a supervisor, a container, a network or a human at a prompt —
 * `svc_*`, `compose`, `cpctl`, `cp_image_id`, `wait_healthy`, `http_ok`,
 * `detect_init`, `host_addresses`, `lan_address`, `ask`, `confirm`, `choose`.
 * **`svc_uninstall` is in that second list with one exception**: its *refusal*
 * arm needs no supervisor and is driven, because refusing to "uninstall" the
 * control plane — a container whose named volume holds the key that mints every
 * token in the fleet — is the half that must not quietly become a `down`.
 *
 * **And `deploy/bootstrap.sh`, which is a third subject rather than a
 * function.** It is served to strangers and piped into `sh`, so four things
 * about it are asserted here and nowhere else: that the pnpm and node it
 * installs still agree with the root manifest (nothing else in this tree reads
 * those two lines — `pincheck` compares the six *version* sites and has never
 * heard of this file); that no control-plane host is written into it, since a
 * fallback constant would point every fork's installer at the author's fleet;
 * that the placeholder `app.ts` substitutes into is spelled there exactly once;
 * and that everything runs from one `main "$@"` on the last line, which is what
 * makes a truncated download define a function instead of running a prefix.
 * Then, driven: `adopt_origin`'s refusals through `--url`, since every request
 * appends `/v1/…` to what it accepts; `credential_body` against a password
 * holding every character the shell and JSON disagree about, with `email` absent
 * when it was not given; that `REEMOAT_API_KEY` leaves the environment on the
 * line after it is read, before any child could inherit the account; and
 * `--uninstall` on an install that died before the checkout existed — the case
 * `nothing_installed` promises the toolchain will be removed for.
 *
 * **And two whose subject is `deploy.sh` rather than a function.**
 * `RELAY_INPUTS` decides whether the relay container is recreated, and getting
 * it wrong is silent in the direction that matters: too narrow, and a relay goes
 * on running code the deploy replaced everywhere else. It is the same
 * "written down twice" shape as the `.dockerignore`/Dockerfile pair, so it is
 * not maintained by inspection — the closure check below walks the relay entry's
 * own imports and fails on anything the pattern does not cover.
 *
 * The second is the restart announcement, which is the one place a deploy tells
 * an operator what it is about to cost. Written as `if daemon … else` it
 * survived the arrival of a third service by answering for it wrongly: the relay
 * was announced as "control-plane", and dropped tunnels were attributed to the
 * API, which after the split is exactly backwards. The block is extracted and
 * run once per member of `SERVICES`, so a missing arm, a name that stops
 * matching and a catch-all answering for somebody else all go red — a shape no
 * amount of reading the file had caught.
 *
 * A third, since Q4.114, is the daemon arm of the per-service loop, which runs
 * `deploy/agents.sh` before deciding the restart. Extracted with `armOf` and run
 * against a stub script under a fake `REPO_ROOT`, so what is asserted is what
 * reached the script — the source read off the env file, one `--skip` per
 * harness — and that a script exiting non-zero is a line on stderr under
 * `lib.sh`'s own `set -e` rather than a deploy that stopped after the checkout
 * had moved.
 *
 * **And `deploy/agents.sh`, a fourth subject, which is driven for real rather
 * than only under `--check`.** A fake `npm` answering the one shape `ensure_npm`
 * calls — an executable that prints its build, a one-line manifest, a package it
 * refuses on request — and this process's own `node` beside it are enough to
 * reach every state the daily run reaches on a machine: an install into a
 * versioned directory, a refresh that repoints the symlink, a build kept under
 * `--skip` and pruned on the run after, a refresh that moves nothing, a refusal
 * that keeps the previous build with no stage left behind, and the two
 * directions of a switched `--source` — an npm copy refreshed from npm under
 * `vendor`, a vendor copy named and counted under `npm`. Nothing here reaches a
 * vendor's host or the registry; what the fake cannot say is whether the real
 * ones still answer that shape. Three more, each a way the daily run was
 * measured going wrong around a process rather than a vendor: the build the
 * symlink named when the run began outliving that run, because the daemon's
 * `--skip` set is a snapshot and a session can start mid-run on a build it never
 * named; a reader that leaves — the daemon on shutdown — no longer ending the run
 * at its next `printf`, with the closed pipe driven for real; and the lock, held
 * by a live pid, taken over from a dead one, and never needed by `--check`.
 *
 * `ask` is in that list and is driven at exactly one point of it, which is worth
 * one sentence rather than a silent exception: with stdin at EOF it returns the
 * default it was offered and never a typed answer, and a *default* is the whole
 * of what went wrong in the relay-URL case below. `lan_address` is stubbed there
 * and stays uncovered — what it answers needs a route table.
 *
 * **And, since the credential bug, six things whose subject is `install.sh`
 * itself.** They are the reason `installLine` and `installBlock` exist: the
 * lines are *extracted from* `install.sh` and the strings they scrape are
 * *extracted from* `packages/control-plane/src/main.ts`, so this file states how
 * they are assembled and nothing else — a copy of either would be a third
 * opinion that stays green through the day one of them changes.
 *
 *   * the two credential scrapes and the source marker beside them, on **both**
 *     of `main.ts`'s arms, against a name carrying both markers, and against the
 *     line that shipped broken (`admin password: taken from … (not printed)`,
 *     whose `$NF` is the word `printed)`);
 *   * the capture loop's exit condition, which used to break on the key alone
 *     and lose a password written to no file;
 *   * the three-outcome report under it, where an empty `$_pw` must reach a
 *     sentence rather than the marker;
 *   * the `adduser` responses, which are read field by field because a pipe into
 *     `json_field` consumed the one-time password to get the id;
 *   * the default offered for `REEMOAT_CP_RELAY_URL`, which was built out of a
 *     variable nothing in this tree assigns — so it silently offered the *API*
 *     publish address for the one value every daemon in the fleet dials;
 *   * and what may close the gate on the one-time admin key, which is the same
 *     credential again by another door: the relay's start block reported into
 *     `START_FAILED`, the variable that gate reads as "the control plane never
 *     came up", so a relay that would not bind skipped the capture over an API
 *     that had already printed the key — into a log bounded at 10m × 5 and
 *     deleted by `compose down`, with the rerun printing nothing because `users`
 *     is no longer empty. Driven both ways, since the gate's real job is to stay
 *     shut for a control plane that genuinely did not start.
 *
 * That list is the same kind of promise as the one above it, and it is smaller
 * than it looks: `cpctl` is *stubbed* in the last of them, so it stays in the
 * uncovered half — what is driven is what the script does with an answer, never
 * that the answer is right. Nothing here runs `install.sh`.
 *
 *   pnpm deploycheck
 */

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

/**
 * A home nobody lives in, holding three characters that matter.
 *
 * `&` is what `esc_sed` escapes and what `esc_xml` has to escape *first*, `<` is
 * what makes a plist unparseable, and `|` is `render_unit`'s own sed delimiter —
 * all three legal in a directory name, and all three substituted into a unit
 * through `@HOME@`. Putting them in the sandbox's own path is what lets one
 * fixture drive the whole escaping chain without a synthetic argument.
 */
const sandbox = realpathSync(tmp("deploycheck-"));
const home = join(sandbox, "home a&b<c|d");
mkdirSync(join(home, ".reemoat"), { recursive: true });

/**
 * Built from nothing, so a `REEMOAT_UNIT_PATH` or a `REEMOAT_ENV_FILE` in the
 * developer's own shell cannot decide what this driver measures.
 */
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

/**
 * `deploy/` as git sees it, taken before anything runs.
 *
 * Compared against itself at the end rather than against "clean": this driver is
 * most likely to be run by somebody *editing* `deploy/`, and a check that
 * demanded a clean tree would go red on their uncommitted work and say nothing
 * about what the run actually touched. The claim is that this driver changed
 * nothing, which is a difference rather than a state.
 */
function deployState(): string {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "deploy"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

const deployBefore = deployState();

/* ------------------------------------------------------------------ *
 * The shell is reachable at all
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere lib.sh thinks it is\n");

check("DEPLOY_DIR is the directory holding it", sh('printf "%s" "$DEPLOY_DIR"').out, deployDir);
check("and REPO_ROOT is its parent", sh('printf "%s" "$REPO_ROOT"').out, repoRoot);

/* ------------------------------------------------------------------ *
 * sq — the one whose failure mode is code execution
 * ------------------------------------------------------------------ */

process.stdout.write("\nquoting a value into a file that gets sourced\n");

/**
 * Every value goes out through `sq`, into a file, back in through `.`, and is
 * compared to what went in. The round trip is the assertion rather than the
 * quoted form: a test that pinned the exact output would pass for a `sq` that
 * quoted correctly and a `.`-source that did not.
 *
 * `PWNED` names a file in `deploy/` deliberately — that is this driver's `cwd`,
 * so a substitution that ran would leave it in the repository where the final
 * `git status` case below would also see it.
 */
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
  /*
   * **The trailing one, which is a different fact and used to be wrong.**
   * `sq` wrapped its output in `$( )`, which strips trailing newlines — measured,
   * a two-byte value `a\n` wrote `K='a'` and read back one byte, so the primitive
   * silently shortened its own input. The interior case above survives that bug
   * untouched, which is exactly why it was green over it.
   */
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
      // shellcheck would object to sourcing a variable path; that is the point.
      '. "$f"',
      '[ "$K" = "$RAW" ] && printf same || printf "DIFFERENT: [%s]" "$K"',
    ].join("\n"),
    { RAW: raw, SANDBOX: sandbox },
  );
  check(`${name} survives the round trip`, run.out, "same");
}

check("and nothing in it ever ran", existsSync(join(deployDir, "PWNED")), false);

/*
 * The other half of the same fact, and the reason the round trip alone is not
 * enough: a value only needs quoting because the file is *executed*. This is the
 * measurement `lib.sh`'s comment records, driven from the unquoted side, so a
 * green run above is known to be `sq` working rather than sourcing being safe.
 */
{
  const run = sh(
    [
      'f="$SANDBOX/unquoted.env"',
      'printf "K=%s\\n" "$RAW" > "$f"',
      '. "$f"',
      'printf "%s" "$K"',
    ].join("\n"),
    /*
     * `$SANDBOX` is left for the shell to expand at source time — which is the
     * very thing being demonstrated — rather than substituted here. It used to be
     * `.replace("$SANDBOX", sandbox)`, which was redundant (the env entry below
     * already resolves it) and was a string replacement, i.e. the one construct
     * `CLAUDE.md` pins a whole invariant against: `$&`, `` $` ``, `$'` and `$$`
     * expand in a string replacement, and `sandbox` is the replacement.
     */
    { RAW: "xy$(touch $SANDBOX/UNQUOTED)", SANDBOX: sandbox },
  );
  check("an unquoted value really does execute on source", run.out, "xy");
  check("and leaves the file behind, which is what sq prevents", existsSync(join(sandbox, "UNQUOTED")), true);
}

/* ------------------------------------------------------------------ *
 * set_env — one function, and it used to have two answers
 * ------------------------------------------------------------------ */

process.stdout.write("\nwriting a value into an environment file\n");

const envFile = join(sandbox, "daemon.env");
const cpEnvFile = join(sandbox, "control-plane.env");

{
  writeFileSync(envFile, "REEMOAT_PORT=7887\nREEMOAT_PORT_EXTRA=keep\n");
  // The append arm: a key the file does not hold.
  const appended = sh('set_env REEMOAT_HOST "127.0.0.1" "$F"; printf "%s" "$(file_value "$F" REEMOAT_HOST)"', {
    F: envFile,
  });
  check("a new key is appended and reads back", appended.out, "127.0.0.1");
  /*
   * **This pins the `chmod 600` after the `mv`, and deliberately says so rather
   * than claiming the umask.** An earlier version of this comment credited
   * `umask 077` — measured by deleting both `umask 077` lines from `lib.sh` and
   * re-running: the mode is still 0600, because `set_env` ends with an
   * unconditional `chmod 600 "$_file"`. So this assertion is green with or
   * without them and cannot be evidence for either.
   *
   * What `umask 077` actually protects is the *transient* `$_file.tmp.$$`, which
   * holds a byte-for-byte copy of a file whose whole content is
   * `REEMOAT_TOKEN` and exists only between the redirect and the `mv`. Nothing
   * here observes it, and observing it would mean racing the function it is
   * testing — so that window is **unchecked**, which is worth one sentence
   * rather than an assertion that pins the wrong thing.
   */
  check("and the file ends up 0600, whatever the umask was", statSync(envFile).mode & 0o777, 0o600);

  // The replace arm, which took the other path through the function.
  const replaced = sh('set_env REEMOAT_HOST "0.0.0.0" "$F"; printf "%s" "$(file_value "$F" REEMOAT_HOST)"', {
    F: envFile,
  });
  check("replacing a key reads back the new value", replaced.out, "0.0.0.0");
  // Both arms, for the same reason and with the same caveat as above: this says
  // the two halves of one function agree about the final mode, not why.
  check("and the replace arm agrees with the append arm about the mode", statSync(envFile).mode & 0o777, 0o600);

  const lines = readFileSync(envFile, "utf8").split("\n").filter((line) => line.startsWith("REEMOAT_HOST="));
  check("replacing writes one line, not two", lines.length, 1);
}

{
  /*
   * `awk -v` escape-processes its value, so the two characters `\` and `n`
   * became a real newline there and injected a second assignment, while the
   * `printf` branch wrote them literally — one function, two answers to what a
   * value is. Passed through the environment now, and asserted on the arm that
   * had the bug: replace, not append.
   */
  writeFileSync(envFile, "REEMOAT_TOKEN=old\n");
  sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\\nINJECTED=yes" });
  const body = readFileSync(envFile, "utf8");
  check("a literal backslash-n injects no second assignment", /^INJECTED=/m.test(body), false);
  check("and the value keeps both characters", sh('printf "%s" "$(file_value "$F" REEMOAT_TOKEN)"', { F: envFile }).out, "a\\nINJECTED=yes");
}

{
  /*
   * `index($0, k "=") == 1` compares a key as text and never as a pattern, so a
   * key that is a *prefix* of another key is not the same key. A `^$_key=` regex
   * gets this right by luck and a substring test gets it wrong.
   */
  writeFileSync(envFile, "REEMOAT_PORT=7887\nREEMOAT_PORT_EXTRA=keep\n");
  sh('set_env REEMOAT_PORT "9999" "$F"', { F: envFile });
  check("a longer key sharing the prefix is untouched", sh('printf "%s" "$(file_value "$F" REEMOAT_PORT_EXTRA)"', { F: envFile }).out, "keep");
  check("while the key that was named did change", sh('printf "%s" "$(file_value "$F" REEMOAT_PORT)"', { F: envFile }).out, "9999");
}

{
  /*
   * An apostrophe is refused for the control plane's file alone, because two
   * parsers read it and compose's dotenv grammar does not understand the POSIX
   * escape `sq` renders — it rejects the whole file, so the stack becomes
   * un-startable and un-inspectable at once.
   */
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

  /*
   * **The `.partial` name, which is the only one the interview ever writes.**
   *
   * `install.sh` copies the env file to `$ENV_FILE.partial`, runs every question
   * against that, and `mv`s it into place at the end — so the guard above, written
   * for the live name, was never consulted on the one path that takes typed input.
   * Measured before the fix: `control-plane.env` refused `it's` and
   * `control-plane.env.partial` wrote it, escape and all, which then became the
   * live file and took `compose build`, `compose up` and even `compose config`
   * down together.
   *
   * Asserted separately from the case above rather than folded into it, because
   * the two names are the whole of what went wrong: a single assertion on either
   * one passes against the broken version.
   */
  const partial = `${cpEnvFile}.partial`;
  writeFileSync(partial, "REEMOAT_CP_HOST=127.0.0.1\n");
  const refusedPartial = sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: partial, V: "it's" });
  check("an apostrophe into the file the interview actually writes is refused too", refusedPartial.status, 2);
  check("and that file is left alone as well", readFileSync(partial, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

{
  /*
   * **The same guard, reached through the documented override instead of the
   * name — which is the door it did not cover.**
   *
   * `REEMOAT_CP_ENV_FILE` may name any path, and both patterns above are
   * *suffixes* of a filename, so a packaged install pointing it at
   * `/etc/reemoat/cp.env` matched neither and wrote the POSIX escape into the
   * one file compose parses. `o'brien` is the value because that is the shape
   * the interview invites: an admin name, typed, one apostrophe, and then a
   * `compose build` that fails before any verb — the stack un-startable and
   * un-inspectable at once, which is exactly what this guard exists to prevent.
   *
   * The two names below are `cp.env` and `d.env` deliberately: neither ends in
   * anything the suffix patterns recognise, so the *only* thing that can refuse
   * one is the resolved path, and the only thing that can allow the other is the
   * resolved path disagreeing with it.
   */
  const overrideCp = join(sandbox, "cp.env");
  const overrides = { REEMOAT_CP_ENV_FILE: overrideCp };

  writeFileSync(overrideCp, "REEMOAT_CP_HOST=127.0.0.1\n");
  const refused = sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: overrideCp, V: "o'brien" });
  check("an apostrophe into the file REEMOAT_CP_ENV_FILE names is refused", refused.status, 2);
  check("naming the parser that cannot read it, as the suffix arms do", /docker compose|dotenv/.test(refused.err), true);
  check("with that file untouched", readFileSync(overrideCp, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");

  // And its `.partial`, which under an override is still the only name the
  // interview ever writes — the same pairing the two suffix arms already have.
  const overridePartial = `${overrideCp}.partial`;
  writeFileSync(overridePartial, "REEMOAT_CP_HOST=127.0.0.1\n");
  check(
    "and its .partial, which is what the interview actually writes",
    sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: overridePartial, V: "o'brien" }).status,
    2,
  );
  check("leaving that one alone too", readFileSync(overridePartial, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");

  /*
   * The other direction, and the reason this is not simply "refuse an apostrophe
   * everywhere": only compose's dotenv parser cannot read the escape. The
   * daemon's file is read by `.` alone, so it takes one — at an equally
   * unrecognisable path, and with *both* overrides set, so a guard that resolved
   * `env_file daemon` as well would be caught here rather than in a wizard.
   */
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

  /*
   * **The suffix patterns are kept beside the resolved path rather than replaced
   * by it**, and this is the assertion that says so: with the override pointing
   * somewhere else entirely, a caller handing `set_env` a path that *is* named
   * `control-plane.env` is still refused. That is a caller whose environment this
   * shell does not agree about — being refused twice costs nothing, and dropping
   * the older arms would take every fixture above with it.
   */
  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  check(
    "and the name is still consulted while the override points elsewhere",
    sh('set_env REEMOAT_CP_NAME "$V" "$F"', { ...overrides, F: cpEnvFile, V: "it's" }).status,
    2,
  );
  check("with that file untouched as well", readFileSync(cpEnvFile, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

{
  /*
   * `ask_secret`, which is where a password is typed.
   *
   * Driven through a pipe, so what is asserted is the refusal loop and the value
   * on stdout — not the `stty` behaviour, which needs a real terminal and stays
   * **unchecked**, said here rather than implied. What that leaves unproven is
   * that echo is actually off; what it proves is that a mistyped, short or
   * unquotable answer costs a re-ask rather than the whole interview.
   */
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

  /*
   * The apostrophe again, from the other end.
   *
   * `set_env` answers one with `exit 2`, which mid-interview means the wizard dies
   * after `$ENV_PARTIAL` is half-written and the operator answers every previous
   * question again — over one character. Here it costs a re-ask.
   */
  const quoted = secret(["it's-a-long-one", "it's-a-long-one", "a-fine-long-password", "a-fine-long-password"]);
  check("an apostrophe re-asks instead of ending the interview", quoted.out, "a-fine-long-password");
  check("and says why that character cannot be used", /dotenv|compose/.test(quoted.err), true);
  check("nothing is written to stdout but the value", secret(["a-fine-long-password", "a-fine-long-password"]).out.includes("password:"), false);

  /*
   * And what it produces survives the file, which is the point of the whole pair.
   *
   * A password is the first value in these files that a human types and that may
   * legitimately contain shell metacharacters — every other one is an address, a
   * port or a URL. This is the documented `xy$(touch PWNED)` measurement aimed at
   * the field that now actually invites it.
   */
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
  /*
   * **A newline is refused for either file, and the failure it prevents is the
   * daemon not starting at all.**
   *
   * `sq` quotes one perfectly, so this is not a quoting rule — it is the replace
   * arm. `awk`'s `index($0, k "=") == 1` matches a *physical* line, so replacing
   * a multi-line value rewrites its first line and orphans the rest. Measured
   * before the refusal existed: a file holding `REEMOAT_TOKEN='line1⏎line2'`,
   * re-set to `new`, became `REEMOAT_TOKEN='new'` followed by a bare `line2'`,
   * and `.`-sourcing it died with `unexpected EOF while looking for matching
   * quote` — which is `run-daemon.sh` unable to start the daemon.
   *
   * Both arms, because the append arm writes a value the *next* replace would
   * then corrupt, so allowing it there only moves the failure one call away.
   */
  writeFileSync(envFile, "REEMOAT_TOKEN=old\n");
  const appended = sh('set_env REEMOAT_NEW "$V" "$F"', { F: envFile, V: "line1\nline2" });
  check("a newline is refused on the way in", appended.status, 2);
  check("naming the arm that cannot survive it", /physical line|orphans/.test(appended.err), true);
  check("and the file is untouched", readFileSync(envFile, "utf8"), "REEMOAT_TOKEN=old\n");

  const replaced = sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\nb" });
  check("and refused on the arm that would have orphaned it", replaced.status, 2);
  check("leaving that file alone too", readFileSync(envFile, "utf8"), "REEMOAT_TOKEN=old\n");

  // A trailing one is the same defect with a quieter shape, so it is refused too.
  check("a value that merely ends in one is refused as well", sh('set_env REEMOAT_TOKEN "$V" "$F"', { F: envFile, V: "a\n" }).status, 2);

  /*
   * The control plane's file gets the same answer, and the two refusals do not
   * shadow each other — a value carrying both is still refused, whichever check
   * reaches it first.
   */
  writeFileSync(cpEnvFile, "REEMOAT_CP_HOST=127.0.0.1\n");
  check("the control plane's file refuses one too", sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: cpEnvFile, V: "a\nb" }).status, 2);
  check("and a value carrying both faults is still refused", sh('set_env REEMOAT_CP_NAME "$V" "$F"', { F: cpEnvFile, V: "it's\nb" }).status, 2);
  check("with that file untouched", readFileSync(cpEnvFile, "utf8"), "REEMOAT_CP_HOST=127.0.0.1\n");
}

/* ------------------------------------------------------------------ *
 * file_value — the one construct here where being wrong is unbounded
 * ------------------------------------------------------------------ */

process.stdout.write("\nreading one value back out\n");

{
  /*
   * Measured and fixed: `[A-Za-z_]*` constrained only the first character, so
   * `A:-$(touch PWNED)` passed the guard, reached the `eval` and created the
   * file. The key is a literal at every call site, so it was latent — but the
   * comment above the check claimed the check is what makes the eval safe.
   */
  const run = sh('file_value "$F" "A:-$(printf %s "\\$(touch $SANDBOX/EVALED)")"', { F: envFile, SANDBOX: sandbox });
  check("a key that is not a key is refused", run.status, 2);
  check("and the eval never ran", existsSync(join(sandbox, "EVALED")), false);
  check("an empty key is refused too", sh('file_value "$F" ""', { F: envFile }).status, 2);
}

/*
 * **In the shape the callers use, which is the whole point of the case.**
 *
 * This was written as `printf "[%s]" "$(file_value …)"` — a command substitution
 * in *argument* position, whose exit status POSIX says does not affect the
 * enclosing command. So `set -e` could never fire and the case could not fail:
 * measured, with the `[ -f "$1" ]` guard deleted from `file_value` outright it
 * still printed `[]` and still went green.
 *
 * Every real call site is an assignment — `_cp_port=$(file_value …)` and
 * `env_value` itself — and that *is* the form errexit propagates through. It is
 * also the form the incident in `lib.sh`'s own comment describes: a deploy killed
 * after it had already moved the checkout. So the status is asserted beside the
 * value, because the value alone was never the part at risk.
 */
{
  const missing = sh('V=$(file_value "$SANDBOX/nope.env" REEMOAT_TOKEN); printf "[%s]" "$V"', { SANDBOX: sandbox });
  check("a file that is not there is empty rather than fatal under set -e", missing.out, "[]");
  check("and the script carries on rather than dying at the assignment", missing.status, 0);
  check("with nothing on stderr to explain a failure that did not happen", missing.err, "");

  const absent = sh('V=$(file_value "$F" REEMOAT_NOT_SET); printf "[%s]" "$V"', { F: envFile });
  check("and so is a key the file does not hold", absent.out, "[]");
  check("also without failing the caller", absent.status, 0);
}

/* ------------------------------------------------------------------ *
 * The three services, and refusing to guess about a fourth
 * ------------------------------------------------------------------ */

process.stdout.write("\nnaming a service\n");

check("daemon is one", sh("if valid_service daemon; then printf yes; else printf no; fi").out, "yes");
check("control-plane is one", sh("if valid_service control-plane; then printf yes; else printf no; fi").out, "yes");
check("relay is one", sh("if valid_service relay; then printf yes; else printf no; fi").out, "yes");
check("a typo is not", sh("if valid_service deamon; then printf yes; else printf no; fi").out, "no");

check("the daemon is supervised by a unit", sh("service_backend daemon").out, "unit");
check("and the control plane by a container", sh("service_backend control-plane").out, "docker");
check("and the relay by one of its own", sh("service_backend relay").out, "docker");

/*
 * The map from a service to the compose service it is, which exists so no
 * `svc_*` verb writes one into a command by hand. Every one of them used to run
 * a bare `compose up -d` — the whole project — and that is precisely the
 * behaviour the split had to end: restarting the API would have gone on
 * recreating the relay beside it, buying nothing while looking complete.
 */
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
  /*
   * A blank branch would be worse than a refusal, and that is the whole reason
   * this is not a `case` with an empty arm: under `set -u` an empty `$(…)` is a
   * value rather than an error, and a unit rendered with an empty ExecStart is
   * something launchd accepts and then fails to start for a reason nothing
   * prints.
   */
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
/*
 * **One file, not two.** The relay and the control plane are two processes of
 * one deployment: the database path, the relay port and the issuer have to agree
 * between them or the pair does not work at all, and a second file is a second
 * place for them to disagree. It is also the file compose itself is given.
 */
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

/**
 * The four CLIs as the npm registry names them. `deploy/agents.sh --source npm`
 * installs exactly these, and `.env.example` names them so an operator behind a
 * firewall knows what to mirror (Q4.114).
 *
 * **A literal, and the one place this driver restates rather than reads.** A
 * package name is the one input to `npm i -g <name>@latest` whose failure mode is
 * not a warning: misspelled, it is either nothing installed under a name the
 * script then reports as done, or — the registry being open — somebody else's
 * package run as this uid, daily. Two copies of that string is the point rather
 * than the hazard. Keyed on `AGENT_IDS`'s own union, so a fifth agent is a compile
 * error here until somebody names its package or decides it has none.
 */
const NPM_PACKAGES: Record<(typeof AGENT_IDS)[number], string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
  kimi: "@moonshot-ai/kimi-code",
};

/*
 * **The two controls an operator has over which build of an agent runs, and the
 * document that has to name both.**
 *
 * Each `AGENT_LOGIN[*].executableEnv` is a *vendor's* variable, and since Q4.114
 * it is the only door its adapter has: `claude-agent-acp`'s `claudeCliPath()`
 * reads it and otherwise `require`s a platform package this repository no longer
 * installs, and `codex-acp`'s `startAcpServer()` is the same shape one variable
 * over. With neither set the daemon runs the first copy it finds — on PATH, then
 * in `MANAGED_CLI_DIRS` — and writes *that* into the variable on every spawn, so
 * setting one here is how an operator chooses, and both survive `agentEnv()`'s
 * strip on purpose. Undocumented, the only way to discover either is to read the
 * adapter's source, and what it decides is not cosmetic: which build runs is
 * which model list is on screen. Measured 2026-09-03, while the adapter still
 * carried a copy of its own: 0.63.0 published `claude-fable-5[1m]` off its
 * 2.1.220 and `claude-fable-5-1[1m]` off a 2.1.259 named here, with every other
 * control identical.
 *
 * Driven off `AGENT_LOGIN` rather than a literal, on the same grounds as the
 * proxy-hop key below: a driver that hardcodes the string it checks for stops
 * checking anything the moment the string moves. That also makes the *absence*
 * meaningful — a harness whose `executableEnv` is null (kimi, opencode) is not
 * required to appear, so this cannot be satisfied by documenting the wrong set.
 */
{
  const daemonExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const named = AGENT_IDS.map((id) => AGENT_LOGIN[id].executableEnv).filter((one): one is string => one !== null);

  check("every harness that has a binary override is documented", named.filter((key) => !daemonExample.includes(key)), []);
  check(
    "each shown as a commented assignment rather than only mentioned in prose",
    named.filter((key) => !new RegExp(`^#\\s*${key}=`, "m").test(daemonExample)),
    [],
  );
  /*
   * `CODEX_HOME` is the trap this block exists to keep documented: it sits one
   * letter away from the variable above it in every listing, names the
   * credential directory rather than the binary, and setting it for this would
   * silently point a login at a store no session reads. The example has to say
   * so, or the pair is worse documented than neither.
   */
  check("and the credential directory is named as not being one of them", /CODEX_HOME/.test(daemonExample), true);
  /*
   * And the one variable here that is *ours*: where `deploy/agents.sh` gets the
   * CLIs from. `vendor` is each vendor's own installer and `npm` is the registry,
   * and the second exists for a machine that cannot reach the first at all — so
   * an example that shows the default and never names the other value has
   * documented the switch for exactly the operator who does not need it. The
   * four package names belong beside it for the same reason: a mirror has to be
   * told what to carry, and the script is not where a firewall operator reads.
   *
   * Read as a paragraph rather than the whole file, so a package name mentioned
   * three screens away — in a comment about something else — does not satisfy
   * the sentence that has to name it here.
   */
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
  // The installer writes this line from its own flag, and the example is where an
  // operator who did not run the installer finds out that it exists.
  check("and the installer flag that writes it", sourceBlock.includes("--agent-source npm"), true);
}

/* ------------------------------------------------------------------ *
 * the script that installs the agents, and keeps them moving
 * ------------------------------------------------------------------ */

/*
 * **`deploy/agents.sh` is the one place a vendor's installer is run, and its
 * properties are load-bearing rather than tidy.**
 *
 * It exists because *none of the four CLIs self-updates under ACP* — every one of
 * their updaters is gated on a terminal a daemon-spawned agent never has — so the
 * cadence is reemoat's. Measured 2026-09-03: kimi 0.29.2 against 0.40.1 upstream,
 * codex 0.146.1 against 0.153.0. And since Q4.114 the copies it installs are the
 * **only** copies: `pnpm install` brings the two ACP adapters and no CLI, so a
 * script that quietly stopped working would leave a fresh machine with no harness
 * at all rather than a stale one — the tile says so, and nothing else does.
 */
{
  const agentsRaw = readFileSync(join(repoRoot, "deploy/agents.sh"), "utf8");
  /*
   * ⚠ **The negative assertions below read the *executable* lines, comments removed
   * — the opposite of the builder's credential rule, and for the opposite reason.**
   * There the file's prose was written to name neither identifier so the absence
   * could be total. Here the prose is where the measurement lives: the paragraph
   * explaining that `kimi upgrade` exits 0 without installing is the most valuable
   * thing in the file, and a check that forbade writing it down would trade an
   * explanation for a grep. Full-line comments only, so nothing inside a string is
   * cut.
   */
  const agentLines = agentsRaw.split("\n").filter((line) => !/^\s*#/.test(line));
  const agents = agentLines.join("\n");
  check("the agent installer was found", agentsRaw.length > 0, true);
  // All three callers exec the file directly — `spawn(script, …)` in the daemon,
  // `"$CHECKOUT/deploy/agents.sh"` in the bootstrap and `"$REPO_ROOT/deploy/agents.sh"`
  // in `deploy.sh` — so a mode bit lost on the way through git is a daily `EACCES`
  // warning, a deploy line saying the script did not finish, and no agent ever
  // refreshed.
  check("and it is executable, because every caller execs it directly", (statSync(join(repoRoot, "deploy/agents.sh")).mode & 0o111) !== 0, true);
  check("and its reasoning is written down rather than left to a reader", agentsRaw.length > agents.length, true);

  /*
   * ⚠ **Never `sudo`.** Two of these installers have no root guard of their own, and
   * run as root they would put a binary the service user cannot update into a
   * directory the service user does not own — a machine that then silently stops
   * updating, which is this script's whole failure mode.
   */
  check("it never reaches for root", /\bsudo\b/.test(agents), false);

  /*
   * ⚠ **`kimi upgrade` may not appear, and this is the one assertion here that pins
   * a measurement rather than a policy.** Without a TTY that verb prints the manual
   * command and **exits 0 without installing**. A timer calling it would report
   * success for ever while the build never moved — worse than not trying, because
   * the failure is invisible from every side.
   */
  check("and never calls kimi's own upgrade, which lies about having run", /kimi\s+(upgrade|update)/.test(agents), false);

  /*
   * The directories are written down twice — here and in `MANAGED_CLI_DIRS`, which
   * is what the *daemon* searches — and the two must not drift: a CLI installed
   * where nothing looks for it is a download that produces a file nothing executes.
   * Imported rather than restated, on the same grounds as the env-example keys above.
   */
  const home = process.env["HOME"] ?? "";
  const named = MANAGED_CLI_DIRS.map((dir) => dir.replace(home, "$HOME_DIR"));
  check(
    "every directory the daemon searches is one this script installs into",
    named.filter((dir) => !agents.includes(dir)),
    [],
  );

  /*
   * Each agent's refresh half, by name. The install half is a vendor URL that may
   * legitimately move; the refresh verb is a decision — `claude update` rather than
   * a re-run of an installer with no already-installed check that downloads ~200 MB
   * every time, and `--method curl` on opencode because without it the resolver can
   * answer `unknown` and stop on a prompt nobody is there to answer. kimi's refresh
   * *is* its install — `ensure_npm`, which is also what the other three take under
   * `--source npm` — and what makes that not a re-download every night is that
   * `npm` resolves `@latest` before it fetches anything.
   */
  check("each agent has a refresh that does not re-download it", [
    /claude update/.test(agents),
    /codex update/.test(agents),
    /opencode upgrade --method curl/.test(agents),
    agents.includes(`ensure_npm kimi ${NPM_PACKAGES.kimi} `),
    /"\$_pkg@latest"/.test(agents),
  ], [true, true, true, true, true]);

  /*
   * Four rules the header states, asserted as text because each was a defect in a
   * draft of this script (Q4.113): the directories are appended to PATH rather than
   * put in front of it; no installer is piped straight into a shell; every download
   * carries a deadline; and a harness whose binary an operator named is left alone
   * — with the names read off `AGENT_LOGIN`, not retyped.
   */
  check("its directories are appended to PATH, never prepended", /^PATH="\$PATH:/m.test(agents), true);
  check("no installer is piped straight into a shell", /curl[^\n]*\|\s*(ba)?sh\b/.test(agents), false);
  check("and every download carries a deadline", /curl [^\n]*--max-time \d+/.test(agents), true);
  /*
   * And is https on every hop. `-L` follows a `Location:` to `http://` by default,
   * and what is downloaded here is executed as this uid, so a vendor (or a hop in
   * between) answering with a downgrade would run a plaintext script. Both flags
   * on the one `curl` line: `--proto` holds the first request, `--proto-redir`
   * every redirect after it.
   */
  check("and refuses a redirect off https", /curl [^\n]*--proto '=https' --proto-redir '=https'[^\n]*--max-time/.test(agents), true);
  /*
   * **A reader that leaves may not end the run.** The daemon spawns this script on
   * pipes and `process.exit`s on shutdown; libuv gives the child default signal
   * dispositions, so the next `printf` is a SIGPIPE and the run dies where it
   * stands. `trap '' PIPE` before the first byte is written, and the three
   * printers swallow the `EPIPE` that replaces it — under `set -e` a failed
   * builtin would end the script just the same. In a subshell, because bash keeps
   * what a failed write could not deliver in its stdio buffer and flushes it into
   * the next `$( … )`: measured, the version read off the manifest came back as
   * every note printed so far. Driven below; this pins the shape.
   */
  const pipeTrapAt = agentLines.findIndex((line) => line === "trap '' PIPE");
  const parserAt = agentLines.findIndex((line) => line.startsWith('for _arg in "$@"; do'));
  check("SIGPIPE is ignored before the first line that could print", [pipeTrapAt !== -1, pipeTrapAt < parserAt], [true, true]);
  // `warn` redirects inside the subshell and in that order: a `2>/dev/null` on
  // the subshell is applied first, and `>&2` inside it then dups `/dev/null` —
  // measured as every warning in the file going nowhere.
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
  /*
   * **One run at a time.** The daemon's `running` guard is a field in its memory
   * and `runScript` spawns detached, so a daemon that exits mid-run leaves the run
   * going and its successor starts another beside it; `deploy.sh` and the
   * bootstrap have no guard at all. The lock is a `mkdir` under the toolchain
   * holding the owner's pid; `sh` holds one trap per signal, so releasing it
   * shares the EXIT trap with `$TMP`, and only the run that took it removes it —
   * `exit 0` on "in progress" must not take another run's lock down on its way
   * out. `--check` takes none, so a preview is never refused by a run.
   */
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
  /*
   * And the vendors' hosts are *here* — the other half of the bootstrap sieve
   * below, which is only a rule about where they may not be. The path after the
   * host is the vendor's to move; the host is what a firewall operator has to be
   * told, which is why `.env.example` names the same three.
   */
  check("the three vendor installers are fetched from here", [
    /download claude https:\/\/claude\.ai\//.test(agents),
    /download codex https:\/\/chatgpt\.com\//.test(agents),
    /download opencode https:\/\/opencode\.ai\//.test(agents),
  ], [true, true, true]);

  /*
   * **The npm arm, which is kimi's arm generalised (Q4.114).** An npm package is
   * written by `npm i -g` over a tree in place — `ETXTBSY` against a live process
   * on Linux and a half-written install everywhere — so every harness that arrives
   * as one goes into `$TOOLCHAIN/<agent>-<version>` and `$TOOLCHAIN/bin/<agent>` is
   * repointed by rename, the same shape as the three native installers. That used
   * to be asserted for kimi by name; it is asserted for the *function* now, since
   * under `--source npm` all four go through it. Staged first, so the final move
   * is one `rename(2)`; and `--skip` withholds only the pruning of the previous
   * build, for whichever harness the daemon names.
   */
  check("an npm-installed harness lands in a directory of its own rather than over the one that runs", /\$_agent-\$_ver/.test(agents) && /mv -f .*bin\/\$_agent/.test(agents), true);
  check("staged under the toolchain, so the move is one rename", /npm" i -g --prefix "\$_stage" "\$_pkg@latest"/.test(agents) && /mv "\$_stage" "\$_build"/.test(agents), true);
  const skipUses = agentLines.filter((line) => /\bskipped "/.test(line));
  check("and --skip guards the prune, for any harness rather than for kimi", skipUses, ['  if skipped "$_agent"; then']);
  check(
    "each of the four is named to the registry, on the line that installs it",
    AGENT_IDS.filter((id) => !agents.includes(`ensure_npm ${id} ${NPM_PACKAGES[id]} `)),
    [],
  );

  /*
   * **Where a copy came from decides how it is refreshed; `--source` decides only
   * how an absent one is installed.** Both directions of a switch were measured
   * going wrong before `provenance` existed: under `npm` a claude the vendor arm
   * had put in `~/.local/bin` read as "installed outside reemoat" and was never
   * refreshed again — on exactly the machine `npm` is for, one whose vendor hosts
   * went dark after a vendor install — and under `vendor` the native updaters ran
   * against copies npm had put under the toolchain. So the rule is one function
   * reading the path `command -v` answers, and every arm below is a `case` over
   * what it says.
   *
   * The three places it knows are the daemon's `MANAGED_CLI_DIRS`, read off the
   * same import as the PATH check above rather than retyped: the toolchain's
   * `bin` is `toolchain`, the two vendor directories are `vendor`, and anything
   * else on PATH is `outside`. One of the three is spelled through `$TOOLCHAIN`,
   * so that assignment is read too and substituted in before the daemon's list is
   * compared against the body — a function that classified the right *variable*
   * pointing at the wrong directory would otherwise pass.
   */
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

  /*
   * Each of the three harnesses with a vendor arm is one `case` over that answer,
   * and the arms are the assertion: `toolchain` goes back to the registry whatever
   * the flag says, `outside` is named and left, and `vendor` is the vendor's own
   * updater — except under `--source npm`, where refreshing it is the one thing a
   * switch cannot do, said as a warning and counted so the daemon warns daily.
   * Only the fall-through, a harness that is absent, reads `$SOURCE` to choose a
   * door.
   *
   * ⚠ **And `ensure_npm` is never a fallback.** A vendor outage that quietly
   * switched a machine to a differently built binary is a change nobody asked
   * for, and the header says so; what makes it true is that every reach into the
   * npm arm from these three is either the `toolchain` arm — a copy that *came*
   * from npm — or the absent-harness line gated on the flag, and the `vendor` arm,
   * the one place an update can fail, holds no call at all. Every call site in the
   * file is then one of three shapes, and a fourth is a red build rather than a
   * fallback nobody reviewed.
   */
  const VENDOR_REFRESH: Record<"claude" | "codex" | "opencode", string> = {
    claude: "claude update",
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
  const npmCalls = agentLines.filter((line) => /\bensure_npm\b/.test(line) && !/^ensure_npm\(\)/.test(line));
  const npmCallShapes = [
    /^\s*toolchain\) ensure_npm \S+ \S+ "[^"]*"; return 0 ;;$/,
    /^\s*if \[ "\$SOURCE" = npm \]; then ensure_npm \S+ \S+ "[^"]*"; return 0; fi$/,
    /^\s*ensure_npm kimi \S+ "[^"]*"$/,
  ];
  check(
    "every reach into the npm arm is a toolchain copy, an absent harness behind the flag, or kimi",
    [npmCalls.filter((line) => !npmCallShapes.some((shape) => shape.test(line))), npmCalls.length],
    [[], 2 * (AGENT_IDS.length - 1) + 1],
  );

  /*
   * `ensure_npm` reads the same answer from its own side — absent is an install,
   * toolchain a refresh, anything else somebody else's copy — and what it says on
   * failure is decided by that verb, because the two leave different machines
   * behind: a failed refresh leaves the previous build linked and running, and
   * only a failed install leaves nothing. The version is read off the manifest
   * npm wrote by the node beside that npm, as JSON; a `sed` anchored on the line
   * start answered nothing on a one-line manifest and every run landed in a
   * directory named by the clock — so nothing was ever "already the build on
   * disk", and every nightly run repointed and pruned over an unchanged version.
   * Both are driven below; this pins the order.
   */
  const ensureNpm = blockIn("agents.sh", agentLines, "ensure_npm", "ensure_npm() {", "}");
  const ensureNpmLines = ensureNpm.split("\n").map((line) => line.trim());
  const at = (startsWith: string): number => ensureNpmLines.findIndex((line) => line.startsWith(startsWith));
  check(
    "ensure_npm reads the same answer: absent is an install, toolchain a refresh, anything else somebody else's",
    [
      ensureNpmLines.includes('"") _verb=install ;;'),
      ensureNpmLines.includes("toolchain) _verb=refresh ;;"),
      ensureNpmLines.includes('*) outside_note "$_pad" "$_agent"; return 0 ;;'),
    ],
    [true, true, true],
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
  /*
   * **The build the symlink named when the run began is not this run's to prune.**
   * The daemon reads `busy()` once, when it spawns the script, and a run is minutes
   * long: a session starting during it resolves `$TOOLCHAIN/bin/<agent>` to the
   * old build, which "every build but the one just linked" then deleted under it.
   * Read with `readlink` before anything moves, and spared beside `$_build`.
   */
  const prevAt = at('_prev=$(readlink "$TOOLCHAIN/bin/$_agent" 2>/dev/null || true)');
  check(
    "ensure_npm reads the build the symlink named before anything moves, and the prune spares it",
    [prevAt !== -1, prevAt < at('case "$(provenance "$_agent")" in'), ensureNpmLines.includes('_prev=${_prev%/bin/*}'), blockIn("agents.sh", agentLines, "prune_builds", "prune_builds() {", "}").includes('[ -d "$_d" ] && [ "$_d" != "$_build" ] && [ "$_d" != "$_prev" ] && rm -rf "$_d"')],
    [true, true, true, true],
  );
  /*
   * **A refresh asks before it stages.** Stage-then-compare wrote and deleted 126 MB
   * per day per npm-installed harness to learn "nothing to do"; now the `refresh`
   * verb reads the launcher's version and asks `npm view <pkg>@latest version`,
   * stages nothing when they agree, and takes the old path — the measured-safe
   * one — whenever `view` fails or answers anything else. Only the refresh verb,
   * since an install has nothing to compare, and never under `--check`. The
   * order is the pin: the question after the verb is known and before the stage.
   */
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
  /*
   * The one arm that is a warning rather than a note, since it is the state in
   * which a harness rots: the vendor's own updater is the only thing that
   * refreshes this copy and `--source npm` was set because that updater's host
   * cannot be reached. Counted, so the daemon's daily run forwards it; naming the
   * path, so it can be removed; naming the remedy, so somebody knows that
   * removing it is enough.
   */
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
    "and the summary counts against the four rather than a number retyped elsewhere",
    agents.includes(`warn "  $failed of ${AGENT_IDS.length} agents were not installed or refreshed; the lines above say why"`),
    true,
  );

  /*
   * **Run, not only read.** A sandbox home, a PATH of the system directories plus a
   * fake `npm` and a real `node`, and first `--check`, so nothing is downloaded and
   * nothing executed — what is measured is the argument parser, the dry run's
   * honesty about what it would do, and the refusals that cost nothing to reach.
   * The real runs against the fake registry follow.
   *
   * **A registry with nothing behind it.** `npm i -g --prefix <p> <pkg>@latest` is
   * the one shape `ensure_npm` calls, and this answers it the way the real one does
   * as far as the script can see: an executable `<p>/bin/<agent>` that prints the
   * build it is, and the manifest npm writes at
   * `<p>/lib/node_modules/<pkg>/package.json` — on **one line**, which is what a
   * published manifest looks like and what the line-anchored `sed` that used to
   * read them answered nothing on. `FAKE_VER` is the build the registry has today;
   * `FAKE_FAIL` names the one package it refuses, exit 1, the way a registry a
   * firewall stops does. Anything else is a fake being asked a question the real
   * one was never asked — exit 3 with the argv on stderr, which no branch of the
   * script reads as success.
   *
   * Keyed on `NPM_PACKAGES` rather than a second list: a package the script asks
   * for that this map does not know is exit 3 and a red run, not a directory
   * named after a typo. The `node` is this process's own, linked in beside the
   * fake: `ensure_npm` reads the manifest with the node *beside the npm it found*,
   * so the one on PATH has to sit in the same directory to be the one measured.
   */
  const agentsPath = join(repoRoot, "deploy/agents.sh");
  const agentsHome = join(sandbox, "agents-home");
  const agentsStubs = join(sandbox, "agents-stubs");
  mkdirSync(agentsHome, { recursive: true });
  mkdirSync(agentsStubs, { recursive: true });
  writeFileSync(
    join(agentsStubs, "npm"),
    [
      "#!/bin/sh",
      // Every call, one line of argv each, into `FAKE_LOG` when a case wants to
      // know what the script asked rather than only what it left on disk.
      '[ -z "${FAKE_LOG:-}" ] || printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
      // `view <pkg>@latest version` is the one question a refresh asks before
      // staging: answered with the build the registry has, refused for the
      // package `FAKE_FAIL` names (a registry that refuses refuses both verbs),
      // and refused for every package under `FAKE_VIEW_FAIL=1` — the registry
      // that cannot answer the question but can still serve the tarball.
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
  /*
   * `--source` takes two spellings and nothing else. The daemon passes it from
   * `REEMOAT_AGENT_SOURCE` after reading the same two, so a third value reaching
   * here is a bug in the daemon rather than a choice — refused with the same 2 as
   * an unknown flag, and by name, because the alternative is a run that read
   * `bogus` as `vendor` and never said so.
   */
  const badSource = runAgents(["--source", "bogus"]);
  check("--source with a value it does not know is refused by name", [badSource.status, badSource.err.includes("--source takes vendor or npm, not bogus")], [2, true]);
  const bareSource = runAgents(["--source"]);
  check("and so is --source with no value", [bareSource.status, bareSource.err.includes("--source needs vendor or npm")], [2, true]);
  const dry = runAgents(["--check", "--skip", "kimi"]);
  check("--check exits 0 and says nothing will be changed", [dry.status, dry.out.includes("nothing will be changed")], [0, true]);
  // The header names the source, because a machine's operator reading the daemon's
  // warning has to be able to tell which door the run went through.
  check("and which installer it would have used", dry.out.includes("with each vendor's own installer"), true);
  check(
    "and claims only what would happen",
    [/claude\s+would install/.test(dry.out), /would download https:\/\/claude\.ai/.test(dry.out), /installed/.test(dry.out.replace(/would install/g, ""))],
    [true, true, false],
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

  /*
   * **The same dry run through the other door.** What `--source npm` has to say
   * is different for every harness — the package, the versioned directory and the
   * symlink it would repoint — and the same in one respect: nothing is fetched
   * from a vendor, which is the whole reason the door exists.
   */
  const npmDry = runAgents(["--check", "--source", "npm"]);
  check("--check --source npm exits 0 and names the registry", [npmDry.status, npmDry.out.includes("from the npm registry")], [0, true]);
  check(
    "and says, per harness, which package into which directory",
    AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g --prefix \\S*/${id}-<version> ${NPM_PACKAGES[id]}@latest, then repoint \\S*/bin/${id}$`, "m").test(npmDry.out)),
    [],
  );
  check("and that each would be an install", AGENT_IDS.filter((id) => !new RegExp(`^  ${id}\\s+would install$`, "m").test(npmDry.out)), []);
  check("with nothing fetched from a vendor", /would download|claude update|codex update|opencode upgrade/.test(npmDry.out), false);
  /*
   * An operator's own copy wins under either source, and the reason is the
   * daemon's rule rather than this script's: `findOnPath` walks `PATH` before
   * `MANAGED_CLI_DIRS`, so a managed copy beside a Homebrew or global-npm one could
   * never be the one that runs, and installing it would be ~100 MB to produce a
   * file nothing executes while reporting success.
   */
  const ownClaude = join(sandbox, "own-claude");
  mkdirSync(ownClaude, { recursive: true });
  writeFileSync(join(ownClaude, "claude"), "#!/bin/sh\necho '2.1.259 (Claude Code)'\n");
  chmodSync(join(ownClaude, "claude"), 0o755);
  const npmOutside = runAgents(["--check", "--source", "npm"], { PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "under npm an operator's own claude is named and left alone",
    [/claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here/.test(npmOutside.out), /claude: would run/.test(npmOutside.out)],
    [true, false],
  );
  check("while the other three would still be installed", ["codex", "opencode", "kimi"].filter((id) => !new RegExp(`^  ${id}: would run: `, "m").test(npmOutside.out)), []);
  // And an override outranks the door too: the daemon never looks past one, so a
  // copy installed beside it from the registry would be the same download nothing runs.
  const npmPinned = runAgents(["--check", "--source", "npm"], { CLAUDE_CODE_EXECUTABLE: "/x/claude", CODEX_PATH: "/x/codex" });
  check(
    "and so is a harness whose binary an operator named",
    [/claude\s+left alone/.test(npmPinned.out), /codex\s+left alone/.test(npmPinned.out), /(claude|codex): would run/.test(npmPinned.out), /kimi: would run/.test(npmPinned.out)],
    [true, true, false, true],
  );
  // And under vendor too: outside is outside whichever door is open, since the
  // reason is the daemon's lookup order and not the flag.
  const vendorOutside = runAgents(["--check"], { PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "and under vendor an operator's own claude is the same sentence, and no verb",
    [/claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here/.test(vendorOutside.out), /claude: would run|claude\s+would/.test(vendorOutside.out)],
    [true, false],
  );

  /*
   * **The npm door, for real.** Everything above is `--check`; what follows runs
   * `--source npm` against the fake registry and reads the toolchain afterwards,
   * because the properties that matter here are on disk rather than in the
   * output: a versioned directory per build, a symlink that is the only thing
   * repointed, a previous build kept for exactly as long as `--skip` says, a
   * stage that never survives a failure. Every case is a state the daily run
   * reaches on a real machine, in the order it reaches them.
   */
  const toolchainOf = (h: string): string => join(h, ".reemoat", "toolchain");
  const buildsOf = (h: string, id: string): string[] =>
    existsSync(toolchainOf(h))
      ? readdirSync(toolchainOf(h)).filter((name) => name.startsWith(`${id}-`) || name.startsWith(`${id}.stage.`)).sort()
      : [];
  const linkOf = (h: string, id: string): string | null => {
    try {
      return readlinkSync(join(toolchainOf(h), "bin", id));
    } catch {
      // No symlink there at all — which is an answer several cases below want, so
      // it is a value rather than a throw.
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

  /*
   * The daily run with a newer build on the registry and one harness live. The
   * install still happens and the symlink still moves — that is the invariant
   * `--skip` does not touch — and the only difference is the build the live
   * agent may be on, kept and said so, against the one nothing is on, pruned.
   */
  const second = runAgents(["--source", "npm", "--skip", "claude"], { HOME: npmHome, FAKE_VER: "2.0.0" });
  check("a newer build on the registry is a refresh of all four", [second.status, second.err, saysEach(second.out, "refresh", "2.0.0")], [0, "", []]);
  check("that repoints every symlink", AGENT_IDS.map((id) => linkOf(npmHome, id)), AGENT_IDS.map((id) => buildOf(npmHome, id, "2.0.0")));
  check(
    "keeps the build a live agent may be on, and says so",
    [buildsOf(npmHome, "claude"), /^  claude\s+previous build kept: an agent is using it$/m.test(second.out)],
    [["claude-1.0.0", "claude-2.0.0"], true],
  );
  /*
   * And keeps the other three's previous build too, saying nothing, because the
   * `--skip` set is a snapshot the daemon took when it spawned the run: a session
   * that started on codex a minute in resolved the symlink to `codex-1.0.0`, and
   * this run used to delete it under that process. The build the symlink named
   * when the run began outlives the run; the one after prunes it.
   */
  check(
    "and keeps the build the symlink named when the run began for the other three, without a note",
    [["codex", "opencode", "kimi"].map((id) => buildsOf(npmHome, id)), (second.out.match(/previous build kept/g) ?? []).length],
    [[["codex-1.0.0", "codex-2.0.0"], ["opencode-1.0.0", "opencode-2.0.0"], ["kimi-1.0.0", "kimi-2.0.0"]], 1],
  );

  /*
   * The run after that, with nothing newer: the registry answers the version the
   * launcher already names, so nothing is staged — the fake records every call,
   * and none of them is an `npm i` — nothing moves (asserted by inode rather than
   * by name, since a stage renamed over the old directory would carry the same
   * name), the note says `current`, and the build kept last night, with no agent
   * on it now, still goes.
   */
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

  /*
   * A registry that cannot answer the question but can still serve the tarball
   * — `view` refused, `i -g` honoured — is the old path: staged, compared, found
   * to be the build on disk, and said as a refresh. What was measured safe costs
   * what it always cost, and no more than that.
   */
  const viewFailLog = join(sandbox, "agents-npm-viewfail.log");
  const viewFail = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "2.0.0", FAKE_VIEW_FAIL: "1", FAKE_LOG: viewFailLog });
  check(
    "a view the registry refuses falls through to staging, and the same build is a refresh that moves nothing",
    [viewFail.status, viewFail.err, saysEach(viewFail.out, "refresh", "2.0.0"), readFileSync(viewFailLog, "utf8").split("\n").filter((line) => line.startsWith("i -g ")).length, statSync(join(toolchainOf(npmHome), "codex-2.0.0")).ino, AGENT_IDS.map((id) => buildsOf(npmHome, id))],
    [0, "", [], AGENT_IDS.length, codexInode, AGENT_IDS.map((id) => [`${id}-2.0.0`])],
  );

  /*
   * **Three builds in a row, with no `--skip` anywhere**, which is the sequence
   * that pins how long a superseded build lives: exactly one run. After v2, v1 is
   * still there — it is the build the symlink named when the v2 run began, and a
   * session the daemon's snapshot never saw may be on it. After v3, v1 is gone
   * and v2 is the one spared. The same build again spares nothing older.
   */
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
  // A bump is asked about and then installed: one `view` and one `i -g` per harness.
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

  /*
   * **The reader leaves.** The daemon spawns this script on pipes and exits on
   * shutdown without waiting; under default dispositions the next `printf` is a
   * SIGPIPE. Driven exactly so — the script's stdout into a `head` that exits after
   * one line, through `spawnSync`, which like the daemon gives the child default
   * signals — the script before the trap ended with status 141, one build of four
   * on disk and, under dash, `$TMP` still there. What is asserted is the whole of
   * what the run should have done regardless of anybody reading it: every build,
   * every symlink, exit 0 (read off stderr, since a pipeline's status is `head`'s),
   * the temporary directory removed and the lock released.
   */
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

  /*
   * **The lock.** A live pid — this driver's own — in a lock somebody else holds
   * is a run in progress: one sentence on stderr naming the pid, exit 0 because
   * every caller's contract is that this script never fails, nothing installed,
   * not even the header printed, and the lock left exactly as found. `--check`
   * walks past it, since a preview changes nothing. A dead pid — a shell that has
   * already exited, whose pid the kernel may not have handed out again yet — is a
   * run the daemon's SIGKILL ended with no trap, and is taken over: the run
   * proceeds and releases the lock at its end. An empty pid file is the
   * microsecond between `mkdir` and the write, or a crash inside it; given a
   * second and still empty, it is the latter and is taken over too.
   */
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
  const gone = spawnSync("sh", ["-c", 'echo "$$"'], { encoding: "utf8" }).stdout.trim();
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

  /*
   * A registry that refuses one refresh. What is true afterwards is that the
   * previous build is still linked and running, and the warning has to say that
   * rather than "no copy" — and the stage the failed install was going into has
   * to be gone, or every failed night leaves one more directory under the toolchain.
   */
  const refused = runAgents(["--source", "npm"], { HOME: npmHome, FAKE_VER: "2.0.0", FAKE_FAIL: NPM_PACKAGES.codex });
  check(
    "a refresh the registry refuses warns, naming the build kept, exit 0",
    [refused.status, /^  codex\s+refresh failed; keeping 2\.0\.0$/m.test(refused.err), refused.err.includes(`1 of ${AGENT_IDS.length} agents were not installed or refreshed`)],
    [0, true, true],
  );
  check("with the symlink still on that build and no stage left behind", [linkOf(npmHome, "codex"), buildsOf(npmHome, "codex")], [buildOf(npmHome, "codex", "2.0.0"), ["codex-2.0.0"]]);
  check("and the other three current regardless", saysEach(refused.out, "current", "2.0.0", ["claude", "opencode", "kimi"]), []);

  /*
   * **The flag switched on a machine that already has its agents.** Every copy
   * here came from npm, so under `--source vendor` every one goes back to npm —
   * the door it came in by — and nothing is fetched from a vendor. The header
   * still names the flag, because that is what the daemon's warning has to be
   * read against; the arms name the door.
   */
  const backThroughNpm = runAgents(["--source", "vendor", "--check"], { HOME: npmHome });
  check(
    "under --source vendor a copy npm installed is still refreshed from npm",
    [
      backThroughNpm.status,
      backThroughNpm.out.includes("with each vendor's own installer"),
      // And says what a refresh would compare rather than asking the registry:
      // a dry run makes no request, and the note names the build it would hold
      // the answer against.
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would ask the registry for ${NPM_PACKAGES[id].replace(/[@/.]/g, "\\$&")}@latest, and stage nothing if it is still 2\\.0\\.0$`, "m").test(backThroughNpm.out)),
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g --prefix \\S*/${id}-<version> ${NPM_PACKAGES[id]}@latest, then repoint \\S*/bin/${id}$`, "m").test(backThroughNpm.out)),
      AGENT_IDS.filter((id) => !new RegExp(`^  ${id}\\s+would refresh$`, "m").test(backThroughNpm.out)),
      /would download|claude update|codex update|opencode upgrade/.test(backThroughNpm.out),
    ],
    [0, true, [], [], [], false],
  );

  /*
   * **And the other direction, which is the one a switch cannot finish.** A claude
   * the vendor's installer put in `~/.local/bin` — the case that read as "outside
   * reemoat" before `provenance` existed — under `--source npm` is the warning,
   * counted, with nothing installed beside it: the daemon would never run a
   * managed copy behind it, so a download there is a file nothing executes. Under
   * `--source vendor` the same copy takes the vendor's own verb, while the three
   * npm installed beside it go back to npm whatever the flag.
   */
  const vendorHome = join(sandbox, "agents-vendor-home");
  const vendorClaude = join(vendorHome, ".local", "bin", "claude");
  mkdirSync(dirname(vendorClaude), { recursive: true });
  writeFileSync(vendorClaude, "#!/bin/sh\necho '2.1.259 (Claude Code)'\n");
  chmodSync(vendorClaude, 0o755);
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
    "under --source vendor the same copy is refreshed by the vendor's own verb",
    [vendorDoor.status, vendorDoor.err, /^  claude: would run: claude update$/m.test(vendorDoor.out), /^  claude\s+would refresh$/m.test(vendorDoor.out)],
    [0, "", true, true],
  );
  check("while the three npm installed beside it go back to npm", ["codex", "opencode", "kimi"].filter((id) => !new RegExp(`^  ${id}: would run: \\S*npm i -g`, "m").test(vendorDoor.out)), []);

  /*
   * An operator's own copy, for real rather than under `--check`: a run under
   * `npm` with a claude on PATH from somewhere else installs the other three and
   * writes nothing for claude, since a managed copy could never be the one that runs.
   */
  const outsideHome = join(sandbox, "agents-outside-home");
  mkdirSync(outsideHome, { recursive: true });
  const outsideRun = runAgents(["--source", "npm"], { HOME: outsideHome, FAKE_VER: "1.0.0", PATH: `/usr/bin:/bin:${agentsStubs}:${ownClaude}` });
  check(
    "a run under npm installs nothing beside an operator's own claude, and says whose it is",
    [outsideRun.status, outsideRun.err, /^  claude\s+2\.1\.259 \(Claude Code\) — installed outside reemoat, not updated from here$/m.test(outsideRun.out), buildsOf(outsideHome, "claude"), saysEach(outsideRun.out, "install", "1.0.0", ["codex", "opencode", "kimi"])],
    [0, "", true, [], []],
  );

  /*
   * A registry that refuses an *install*, on a fresh machine. There is no floor
   * under it any more, so the warning has to say what that now costs — a harness
   * absent until the next run — and nothing half-made may be left: no build, no
   * symlink to nowhere, no stage.
   */
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

  // The shape `bootstrap.sh` is held to, for the same reason: a truncated download
  // must define functions and then do nothing, rather than half-run.
  const agentCode = agentLines.filter((line) => line.trim().length > 0);
  check("everything runs from one call on the last line", agentCode.at(-1), 'main "$@"');
  check("and nothing else calls it", agentCode.filter((line) => /^main /.test(line)).length, 1);

  /*
   * **And the installer calls it, before the daemon exists.**
   *
   * ⚠ **Order is the assertion, not presence.** `hand_off` is where the unit is
   * rendered and the service started, so a call after it means the first thing
   * somebody sees is an app whose agents are missing — working, which is why
   * nothing would fail, and empty, which is the whole complaint this closes.
   */
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

  /*
   * **One answer, given twice, and the two must agree (Q4.114).** The installer's
   * first run of the script and the daemon's daily one have to take the same door,
   * or a machine installed from a mirror refreshes from the vendors the next
   * morning — through a firewall that refuses, with a warning and a harness that
   * stops moving. So `--agent-source` is a flag the bootstrap validates itself,
   * passes to its own run as `--source`, and writes into the env file for the
   * daemon's, **only when it is not the default**: an env file says what somebody
   * chose and nothing else, and the daemon reads an absent value as `vendor`.
   * Each of those is a line, and each is asserted as one, inside the function it
   * belongs to — the `write_env_file` arm is the one where the argument order is
   * load-bearing, since the test inside the `sh -c` reads `$2` and only the call
   * line says that `$2` is `AGENT_SOURCE`.
   */
  const bootFn = (name: string): string => blockIn("bootstrap.sh", bootLines, name, `${name}() {`, "}");
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

  /*
   * **And that arm, run.** The text check pins the line; this lifts the body the
   * bootstrap hands to `sh -c` out of it and runs it with the real `lib.sh` as its
   * `$0` — the trick the comment above the function describes, since `lib.sh`
   * derives `DEPLOY_DIR` from `$0` and under `curl | sh` that is the bare string
   * `sh`. `env_file` honours `REEMOAT_ENV_FILE`, so the file lands in the sandbox
   * while the real `.env.example` is what it is seeded from; the code arrives on
   * stdin, as it does from `printf`. What a run under `vendor` writes is the
   * assertion that matters: no source line at all, so the file says what somebody
   * chose and nothing else.
   */
  const envBody = /sh -c '([\s\S]*?)' "\$CHECKOUT\/deploy\/lib\.sh"/.exec(writeEnv)?.[1];
  check("write_env_file's body can be lifted out of it", envBody !== undefined, true);
  const envHome = join(sandbox, "bootstrap-env-home");
  const writeEnvRun = (source: string): { run: Run; file: string } => {
    const file = join(envHome, source, "daemon.env");
    const run = spawnSync("sh", ["-c", envBody ?? "false", join(deployDir, "lib.sh"), "https://cp.example", source], {
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
    ],
    [0, npmEnv.file, "signed", "https://cp.example", "code-1", "npm"],
  );
  check("into a directory and a file closed to everybody else", [statSync(dirname(npmEnv.file)).mode & 0o777, statSync(npmEnv.file).mode & 0o777], [0o700, 0o600]);
  const vendorEnv = writeEnvRun("vendor");
  check(
    "and under vendor the same file with no source line at all",
    [
      vendorEnv.run.status,
      valueIn(vendorEnv.file, "REEMOAT_CONTROL_PLANE"),
      valueIn(vendorEnv.file, "REEMOAT_AGENT_SOURCE"),
      readFileSync(vendorEnv.file, "utf8").split("\n").filter((line) => /^REEMOAT_AGENT_SOURCE=/.test(line)),
    ],
    [0, "https://cp.example", "", []],
  );

  /*
   * **`install_node` removes node's own files and never the directory.** The
   * toolchain also holds every npm-installed harness — kimi always, all four
   * under `--agent-source npm` — each in a versioned directory a live session may
   * be on, and this was `rm -rf "$TOOLCHAIN"`: a re-run that found node missing
   * or too old took every one of them with it (Q4.114). The list is the tarball's
   * top level; what is pinned is that it is a list, that node's own binaries are
   * on it, that nothing on it is a directory the harnesses live under, and that
   * it runs before the unpack rather than after.
   */
  const installNode = bootFn("install_node");
  // Code lines only: the function's own comment names the line that was wrong,
  // which is the measurement and may stay — the same rule the `agents.sh`
  // negatives above follow.
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

  /*
   * And the agents script gets node's directory in front of PATH from the
   * installer, in a subshell so nothing after it inherits the change: the npm
   * arm needs an `npm` and a `node`, and with `--node` naming one off PATH there
   * would otherwise be neither — every npm-installed harness "skipped: no npm to
   * install it with" on a machine that had just installed one.
   */
  const agentsCall = bootFn("install_agents").split("\n").find((line) => line.includes("deploy/agents.sh")) ?? "";
  check(
    "install_agents runs the script with the installed node's directory in front",
    agentsCall.trim().startsWith('( PATH="$(dirname -- "$NODE_BIN"):$PATH" "$CHECKOUT/deploy/agents.sh" --source "$AGENT_SOURCE" )'),
    true,
  );

  /*
   * `--agent-source` on a machine that is already set up would be accepted and
   * change nothing: the install writes it and the daemon reads it, and neither
   * happens on "Update", which is `deploy.sh` reading the env file. So whether
   * the flag was *given* is remembered separately from its value — the value
   * defaults to `vendor` either way — and `existing_install` refuses it, naming
   * where the setting lives now and the script that would apply it today, before
   * any menu or non-interactive exit. And only *after* the env file has been
   * found and read, since a fresh machine given the flag must carry on and
   * install with it.
   */
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
  /*
   * The vendor hostnames stay in `agents.sh`. `bootstrap.sh` is held to a sieve
   * saying the only lines naming a host are the ones resolving a control plane, and
   * inlining a `curl https://claude.ai/install.sh` here would go red against it —
   * which is the right outcome, and this states why rather than leaving it to be
   * rediscovered.
   *
   * ⚠ **Named in prose is allowed; fetched from is not** — the same line the
   * control-plane sieve draws. `--agent-source`'s usage text has to say *which*
   * hosts `npm` is the answer to, or the flag is documented for exactly the
   * operator who cannot tell whether they need it; so the test is a URL, not a
   * word. The registry's own host may not appear even as a word: `npm` is pointed
   * at a mirror through its own configuration, and a bootstrap that named the
   * public registry would be one edit from writing it into that configuration.
   */
  check("and names no vendor of its own", /https?:\/\/(claude\.ai|chatgpt\.com|opencode\.ai)|registry\.npmjs/.test(boot), false);
}

/* ------------------------------------------------------------------ *
 * the setting that decides what a rate limit counts
 * ------------------------------------------------------------------ */

/*
 * **Three files have to agree about one key, and two of them are shell.**
 *
 * `REEMOAT_CP_TRUSTED_PROXY_HOPS` decides how much of `x-forwarded-for` the API
 * believes, and therefore what the login throttle, the per-address backstop and
 * the enrollment counter key on. An installer that never writes it leaves every
 * proxied instance with all callers in one bucket; an example that never
 * mentions it leaves an operator no way to find the remedy the runtime warning
 * names. Neither failure is visible from inside the running service, which is
 * why they are asserted here rather than left to be noticed.
 *
 * Read out of the files themselves rather than restated, on the same grounds as
 * the admin-key scrape one section down: a driver that hardcodes the string it
 * is checking for stops checking anything the moment the string moves.
 */
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
  /*
   * And asks rather than assuming. A `set_env` with a literal would be a
   * decision made on the operator's behalf about whether a proxy exists, which
   * is the one fact this script cannot observe — the bind address is an
   * intention, not evidence, since a Tailnet and an `ssh -L` both look like
   * loopback with nothing in front.
   */
  check("from an answer rather than a literal", new RegExp(`set_env ${KEY} "\\$`).test(installer), true);

  /*
   * **The two values baked into every daemon at enrollment, and the document
   * that says so.**
   *
   * `REEMOAT_CP_RELAY_URL` lands in `identity.relay_url` and
   * `REEMOAT_CP_ISSUER` in `identity.issuer`; the daemon makes exactly one
   * request to the control plane, ever, and there is no env override on its
   * side. So changing either costs a re-enrollment of the whole fleet — which is
   * a fact about *operations* that no driver can enforce and every operator has
   * to be told before the first machine enrolls, not when they need it.
   *
   * Asserted as "the document exists and names the keys" rather than by reading
   * its prose: what would rot is the link and the names, and both are checkable.
   */
  const relays = readFileSync(join(repoRoot, "deploy/RELAYS.md"), "utf8");
  const readme = readFileSync(join(repoRoot, "deploy/README.md"), "utf8");
  check("the multi-relay document names what enrollment bakes", [
    // A boundary, because `REEMOAT_CP_RELAY_URL` is a substring of the plural
    // asserted below — and the singular/plural confusion is the exact thing this
    // document exists to prevent, so the check for it must not be satisfied by
    // the other one.
    /REEMOAT_CP_RELAY_URL(?![A-Z_])/.test(relays),
    relays.includes("REEMOAT_CP_ISSUER"),
    relays.includes("identity.relay_url"),
  ], [true, true, true]);
  check("and the routing key it exists to explain", relays.includes("REEMOAT_CP_RELAY_URLS"), true);
  check("which the example documents too", cpExample.includes("REEMOAT_CP_RELAY_URLS"), true);
  // Findable from the front door, or it is a file nobody opens until afterwards.
  check("and the deploy README points at it", readme.includes("RELAYS.md"), true);
}

/* ------------------------------------------------------------------ *
 * runtime_path — the ordering that used to be a privilege path
 * ------------------------------------------------------------------ */

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
  /*
   * The case the second loop exists for: a tool whose directory is appended, but
   * which re-resolves to a *different* binary under the PATH just built. Left
   * appended, the unit would run something other than the copy that was checked.
   *
   * `sh` is the fixture because it is guaranteed to exist in a system directory,
   * so the disagreement is real rather than arranged.
   */
  const bin = join(sandbox, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sh"), "#!/bin/sh\n", { mode: 0o755 });
  const run = sh('runtime_path "$B/sh"', { B: bin });
  check("a tool that re-resolves elsewhere goes in front instead", run.out.startsWith(`${bin}:`), true);
  check("and the system directories keep their order behind it", run.out, `${bin}:${SYSTEM_PATH}`);
  /*
   * The reorder is stated rather than silent. It used to *refuse*, and the
   * refusal was unactionable — `_acc` always begins with the system directories,
   * so the printed remedy produced the identical refusal for ever.
   */
  check("and it says out loud that it did so", run.err.includes("goes ahead of the system directories"), true);

  /*
   * **The warning under it, which is the only security-relevant output this
   * function has and was the one thing here nothing drove.**
   *
   * `CLAUDE.md` says the ordering was never the fence — what made the old order
   * dangerous is *the directory being writable by more than its owner*, and this
   * is the branch that says so. It was silent in every case above because
   * `mkdirSync` takes `0o777 & ~umask`, i.e. 0755 at the usual 022, and the
   * assertion above is green either way.
   *
   * Both directions, because a pattern that never matches and a pattern that
   * always matches are equally green with one. And the mode is set explicitly
   * rather than inherited, so the ambient umask cannot decide what this measures.
   *
   * This is also the case the CI step exists for. `case "$_mode" in d????w* |
   * d???????w*)` is fed by `ls -ld … | awk '{print $1 " " $3 ":" $4}'`, which is
   * the one place BSD and GNU output could disagree — macOS appends `@` for
   * xattrs and GNU appends `.` or `+` for SELinux and ACLs, both past the tenth
   * character these patterns read.
   */
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

  // Warned about, never refused: the refusal this replaced was unactionable.
  chmodSync(bin, 0o775);
  check("but it is still a warning, so the PATH is still printed", sh('runtime_path "$B/sh"', { B: bin }).out, `${bin}:${SYSTEM_PATH}`);
  chmodSync(bin, 0o755);
}

check(
  "an explicit override wins outright",
  sh("runtime_path /usr/bin/env", { REEMOAT_UNIT_PATH: "/only/this" }).out,
  "/only/this",
);

/* ------------------------------------------------------------------ *
 * Escaping, which decides whether a rendered unit parses at all
 * ------------------------------------------------------------------ */

process.stdout.write("\nescaping a value into a template\n");

check("sed's replacement metacharacters are escaped", sh(`esc_sed 'a&b|c\\d'`).out, "a\\&b\\|c\\\\d");
check("an ampersand becomes an entity", sh("esc_xml 'a&b'").out, "a&amp;b");
check("and the angle brackets too", sh("esc_xml '<x>'").out, "&lt;x&gt;");
/*
 * Ampersand first, or the entities introduced by the two rules after it get
 * escaped again — `<` would become `&amp;lt;` and the plist would say the wrong
 * thing rather than fail to parse, which is worse.
 */
check("and the ordering does not double-escape what it just introduced", sh("esc_xml '&<>'").out, "&amp;&lt;&gt;");
check(
  "XML escaping happens only where the template is XML",
  [sh("INIT_SYSTEM=launchd; subst_value 'a&b'").out, sh("INIT_SYSTEM=systemd; subst_value 'a&b'").out],
  ["a\\&amp;b", "a\\&b"],
);

/* ------------------------------------------------------------------ *
 * render_unit, on both init systems, from whichever this is
 * ------------------------------------------------------------------ */

process.stdout.write("\nrendering a unit\n");

for (const init of ["launchd", "systemd"] as const) {
  const target = join(sandbox, `out.${init}`);
  const run = sh(`INIT_SYSTEM=${init}; render_unit daemon "$T" 2>/dev/null`, { T: target });
  check(`${init}: rendering succeeds`, run.status, 0);

  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  /*
   * The failure this catches is a template gaining a placeholder that
   * `render_unit`'s `sed` does not substitute — which renders a unit naming a
   * program called `@EXEC@`, accepted by the supervisor and then failing to
   * start for a reason nothing prints.
   */
  check(`${init}: no placeholder survives`, text.match(/@[A-Z_]+@/g), null);
  check(`${init}: it runs the daemon's wrapper`, text.includes(join(deployDir, "run-daemon.sh")), true);
  check(`${init}: with the repository as its working directory`, text.includes(repoRoot), true);
  check(`${init}: and a PATH resolved rather than written down`, text.includes(SYSTEM_PATH), true);
}

{
  /*
   * The sandbox home holds `&`, `<` and `|` — one is sed's replacement
   * metacharacter, one is the delimiter `render_unit` chose because every value
   * is a path, and one makes a plist unparseable. All three arrive through
   * `@HOME@`, so a single fixture drives the whole chain on both templates.
   */
  const plist = readFileSync(join(sandbox, "out.launchd"), "utf8");

  check("a plist gets the XML-escaped home", plist.includes("home a&amp;b&lt;c|d"), true);
  check("and never the raw characters that would break the parse", /home a&b<c/.test(plist), false);
}

{
  /*
   * **The unit names the environment file it was installed with, and until
   * `@ENV_FILE@` existed it named none at all.**
   *
   * `REEMOAT_ENV_FILE` is obeyed by `env_file`, by `install.sh` and by the
   * health probe — and by nothing the supervisor starts, because neither
   * `launchctl bootstrap` nor `systemctl --user` carries the invoking shell's
   * environment into the job. So the wrapper fell back to
   * `$HOME/.reemoat/daemon.env` while everything around it had agreed on
   * another path: configuring one file and supervising another.
   *
   * The `no placeholder survives` case above cannot see this, and that is why
   * these are here rather than folded into it — deleting the placeholder from
   * both templates *and* the substitution from `render_unit` leaves that check
   * green, because what it forbids is a placeholder left behind, not a value
   * left out.
   *
   * The strings are literal, like the `@HOME@` case above them, so the escaping
   * is asserted in the same breath as the substitution: the sandbox home carries
   * `&` and `<`, which the plist must entity-encode, and a **space**, which is
   * what the systemd quoting is for.
   */
  const plist = readFileSync(join(sandbox, "out.launchd"), "utf8");
  const service = readFileSync(join(sandbox, "out.systemd"), "utf8");

  check("a launchd job is told which environment file to read", plist.includes("<key>REEMOAT_ENV_FILE</key>"), true);
  check("with the path entity-encoded like every other one in it", plist.includes("home a&amp;b&lt;c|d/.reemoat/daemon.env"), true);

  /*
   * `Environment=` is split on whitespace by systemd, and this value lives under
   * `$HOME`, which on a desktop install is allowed to hold a space — the sandbox
   * home does, so an unquoted assignment would truncate here rather than on
   * somebody's machine.
   */
  check(
    "and a systemd unit gets it quoted, because the path may contain a space",
    service.includes(`Environment="REEMOAT_ENV_FILE=${home}/.reemoat/daemon.env"`),
    true,
  );

  /*
   * The override, which is the case the whole placeholder exists for: the two
   * outcomes it closes are an exit 2 into `KeepAlive`/`Restart=always` for ever,
   * and — worse — a wrapper that finds a *stale* default file and comes up on the
   * wrong token and the wrong database while `wait_healthy`, reading the port out
   * of the file `install.sh` had just written, reports it green. Both defaults
   * are 7887, so nothing downstream notices.
   *
   * Asserted in both directions: the override arrives, and the default path is
   * nowhere in the file. The second is the half that fails if `render_unit`
   * substitutes something other than `env_file "$_svc"`.
   *
   * **The fixture path is deliberately not `/etc/reemoat/d.env`**, which is the
   * example both the `env_file` case above and the plist's own comment use.
   * Measured against a copy of `deploy/` with the placeholder deleted from both
   * templates and the substitution deleted from `render_unit`: a plist comment is
   * *rendered into the plist*, that comment quotes that exact path, and so the
   * launchd half of this case went green with the fix reverted. A check that
   * cannot fail is worse than no check, and what distinguishes a substituted
   * value from prose about it is a value no prose would write.
   */
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
  /*
   * The same chain on the other template, through the other value.
   *
   * `@HOME@` and `@LOG_DIR@` appear only in the plist — launchd needs both
   * spelled out because it starts a job with almost no environment, while
   * systemd inherits a user manager's — so the systemd side has to be driven
   * through something it does substitute. `REEMOAT_UNIT_PATH` is that, and it
   * is the one value here an operator types.
   *
   * It is not XML, so the value must arrive **literally**: that is the assertion
   * that `subst_value` decides per template rather than escaping everything the
   * same way, and that `esc_sed` survives its own delimiter. `|` is what
   * `render_unit` chose precisely because every value is a path, so a `|` in one
   * is the case that would end the `s|…|…|` early.
   */
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
  /*
   * `require_init` is what stands between a host with neither supervisor and a
   * unit rendered for one it does not have.
   */
  const run = sh('INIT_SYSTEM=none; render_unit daemon "$T"', { T: join(sandbox, "neither") });
  check("a host with no supervisor is refused rather than guessed at", run.status, 2);
  check("and told about the wrapper it can run from its own", run.err.includes("run-daemon.sh"), true);
}

/* ------------------------------------------------------------------ *
 * Where a service answers, which is the one this driver was named for
 *
 * The paragraph `deploycheck` replaced in `CLAUDE.md` said the parts of `deploy/`
 * most worth asserting were "that a unit renders, that a wrong service name is
 * refused, **that the health address survives a wildcard bind and a
 * `REEMOAT_PORT=0`**". The first two landed with the first version of this file
 * and the third did not, so the sentence was answered two thirds of the way and
 * the replacement text did not say which third was missing. This is that third.
 *
 * `service_origin` is the single rule for what address a service answers on, and
 * both the health probe and `cpctl.env` read it — so a wrong answer here is a
 * deploy that reports a healthy daemon as failed, or probes somebody else's port.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhere a service answers\n");

{
  const svcEnv = join(home, ".reemoat", "daemon.env");
  const cpSvcEnv = join(home, ".reemoat", "control-plane.env");
  const origin = (svc: string): string => sh(`service_origin ${svc}`).out;
  const probe = (svc: string): string => sh(`health_probe_target ${svc}`).out;

  // No file at all is not an address, and it must not become one.
  check("a service with no environment file has no origin", origin("daemon"), "");
  check("and the probe says which file it wanted rather than failing", probe("daemon").startsWith("skip no environment file at "), true);
  check("naming the path it looked in", probe("daemon").includes(svcEnv), true);

  writeFileSync(svcEnv, "REEMOAT_HOST=127.0.0.1\nREEMOAT_PORT=7887\n");
  check("an ordinary daemon answers on what it bound", origin("daemon"), "http://127.0.0.1:7887");
  check("and the probe builds /health onto it", probe("daemon"), "ok http://127.0.0.1:7887/health");

  /*
   * **A wildcard bind is not an address you can connect to**, and this is the
   * half the old sentence named. `0.0.0.0` means every interface, so the probe
   * has to pick one — loopback, because it is always part of what a wildcard
   * covers and the probe is always local. Getting this wrong reports a perfectly
   * healthy service as unreachable, after `git reset --hard` has already run.
   */
  writeFileSync(svcEnv, "REEMOAT_HOST=0.0.0.0\nREEMOAT_PORT=7887\n");
  check("a wildcard bind is probed on loopback", origin("daemon"), "http://127.0.0.1:7887");
  writeFileSync(svcEnv, "REEMOAT_HOST=::\nREEMOAT_PORT=7887\n");
  check("and the v6 wildcard on the v6 loopback, in brackets", origin("daemon"), "http://[::1]:7887");
  writeFileSync(svcEnv, "REEMOAT_HOST=\nREEMOAT_PORT=7887\n");
  check("an empty host is a wildcard too, not a hostname", origin("daemon"), "http://127.0.0.1:7887");

  /*
   * **`REEMOAT_PORT=0` is the other half, and it is a supported setting rather
   * than a mistake**: a relay-only daemon lets the kernel choose, because nothing
   * outside ever addresses its listener. There is then no port to learn from a
   * file, so the honest answer is nothing at all — and the probe has to report
   * that as *skipped* rather than as a red, or every relay-only host fails its
   * own deploy.
   */
  writeFileSync(svcEnv, "REEMOAT_HOST=127.0.0.1\nREEMOAT_PORT=0\n");
  check("a kernel-assigned port yields no origin to probe", origin("daemon"), "");
  check("and the probe skips rather than failing the deploy", probe("daemon"), "skip daemon listens on a kernel-assigned port");

  // The defaults, which is what an env file that says nothing means.
  writeFileSync(svcEnv, "REEMOAT_TOKEN=x\n");
  check("a file that names neither falls back to the documented pair", origin("daemon"), "http://127.0.0.1:7887");

  /*
   * The control plane reads a *different* pair, and that asymmetry is the point:
   * its bind is pinned to 0.0.0.0 inside the container and says nothing about who
   * can reach it, so the publish address is the one that answers.
   */
  writeFileSync(cpSvcEnv, "REEMOAT_CP_PUBLISH=127.0.0.1\nREEMOAT_CP_PORT=7888\n");
  check("the control plane answers on what it publishes", origin("control-plane"), "http://127.0.0.1:7888");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_HOST=0.0.0.0\n");
  check("and reads its own names, not the daemon's", origin("control-plane"), "http://127.0.0.1:7888");
  writeFileSync(cpSvcEnv, "REEMOAT_CP_PUBLISH=0.0.0.0\nREEMOAT_CP_PORT=7888\n");
  check("a published wildcard is loopback here too", origin("control-plane"), "http://127.0.0.1:7888");

  /*
   * The relay reads a *third* pair out of that same file, and probes a different
   * path — which is the assertion worth having here.
   *
   * `/health` at the relay belongs to the daemon on the far side of a tunnel: it
   * is exactly what a browser fetches, with a token, to decide whether a machine
   * is reachable at all. A relay that answered it would report every machine in
   * the fleet as up, and this deploy probe would go green against a relay
   * carrying nothing. So its own health route is under the prefix it already
   * reserves for `TUNNEL_PATH`, and this is the pair that pins it.
   */
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

  /*
   * `env_value` is `file_value` composed with `env_file`, and it is the form the
   * callers actually use — so the key guard has to survive the composition.
   */
  writeFileSync(svcEnv, "REEMOAT_TOKEN=from-the-env-file\n");
  check("env_value reads a service's own file without being told where it is", sh("env_value daemon REEMOAT_TOKEN").out, "from-the-env-file");
  /*
   * Single quotes in the *shell*, so `$( )` reaches `env_value` as text rather
   * than being expanded by this harness on the way in — which it was at first,
   * and which made the case create the file itself and then blame the eval.
   */
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
  /*
   * `resolve_bin` is what puts an absolute path into a unit. A unit cannot run a
   * shell builtin or a relative path, and launchd and systemd read no profile —
   * so "not found" and "found, but not as a path" both have to be refusals rather
   * than something written into a file that then fails to start.
   */
  // Through `printf` on both sides: `resolve_bin` writes with `printf '%s'` and
  // `command -v` writes a line, so a raw comparison differs by a newline alone.
  check("a real program resolves to an absolute path", sh("resolve_bin sh whatever").out, sh('printf "%s" "$(command -v sh)"').out);
  const missing = sh("resolve_bin definitely-not-a-real-program-xyz whatever");
  check("one that is not there is a refusal", missing.status, 2);
  check("naming the thing that wanted it, not just the thing missing", missing.err.includes("whatever"), true);
  check("and printing nothing to be substituted into a template", missing.out, "");
}

/* ------------------------------------------------------------------ *
 * INIT_SYSTEM=none, the state lib.sh says nothing has ever reached
 *
 * `detect_init`'s own comment: "`INIT_SYSTEM=none` is a new reachable state that
 * most of the functions in this file cannot serve … It is also untested on both
 * machines this has ever run on, because neither can reach it." This driver is
 * the thing that can reach it — it sets `INIT_SYSTEM` by hand throughout — so
 * leaving it undriven left the one branch the file itself flags as unproven.
 *
 * What is asserted is today's behaviour rather than a wish: these four derive
 * from a `case` with no matching arm and therefore print nothing. That is the
 * *shape* `service_exec` and `render_unit` deliberately refuse instead, and
 * pinning it is what makes a later change to either visible rather than silent.
 * ------------------------------------------------------------------ */

process.stdout.write("\na host with neither supervisor\n");

for (const fn of ["unit_label daemon", "unit_target daemon", "log_dir", "unit_template"] as const) {
  const run = sh(`INIT_SYSTEM=none; printf "[%s]" "$(${fn})"`);
  check(`${fn.split(" ")[0]} derives nothing rather than guessing`, run.out, "[]");
  check(`${fn.split(" ")[0]} does not fail its caller for it`, run.status, 0);
}
/*
 * `subst_value` is the fifth, and it is the one that shows *why* the two
 * refusals exist. It also derives nothing here — its `case` has no `none` arm —
 * so under `set -u` an empty `$( )` is a value rather than an error, and a unit
 * rendered through it would carry empty settings that a supervisor accepts and
 * then fails to start on, printing nothing. That shape is unreachable today only
 * because `render_unit` refuses first, which is asserted above; this pins the
 * thing it is protecting against.
 */
check("subst_value derives nothing too, which is the shape the refusals exist for", sh("INIT_SYSTEM=none; printf '[%s]' \"$(subst_value 'a&b')\"").out, "[]");

/* ------------------------------------------------------------------ *
 * json_field — because node is a hard requirement here and jq is not
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The one-time credentials, read back out of a service's log
 *
 * This is the first thing here whose subject is `install.sh` rather than
 * `lib.sh`, and the reason is the bug it was written for: `main.ts`'s
 * not-generated arm printed `admin password: taken from …_PASSWORD (not
 * printed)` — the marker, on a line carrying no password — and the installer's
 * `$NF` scrape duly handed the operator the literal string `printed)` and told
 * them to sign in with it. Nothing saw it, because that arm is option 2 of this
 * script's own interview and `imagecheck` drives only the generated one.
 *
 * So both arms are driven here, where neither a container nor a human is
 * needed: the *lines* come out of `install.sh` and the *strings* out of
 * `main.ts`, and this file states only how they are assembled.
 * ------------------------------------------------------------------ */

const installLines = readFileSync(join(deployDir, "install.sh"), "utf8").split("\n");
const deployLines = readFileSync(join(deployDir, "deploy.sh"), "utf8").split("\n");
const mainSource = readFileSync(join(repoRoot, "packages/control-plane/src/main.ts"), "utf8");

/**
 * One line of `install.sh`, taken from the file rather than restated here.
 *
 * Extraction rather than a copy, for the reason every hand-mirrored constant in
 * this repository gets a comment: a copy asserts what *this* file believes the
 * installer does, and stays green through the day somebody changes the other
 * one. What is driven below is the shipped `awk` program, byte for byte.
 *
 * It has to be a fragment rather than the script, because the scrape lives
 * inside a branch that has already started a container and written an
 * environment file — a driver that ran `install.sh` would be installing
 * something, which is the objection this file's own header raises against
 * driving the interview.
 *
 * A miss is a failure *and* a failing command: the placeholder is `false`, so
 * every case built on a line that has moved goes red rather than quietly
 * passing on an empty string.
 */
function lineIn(file: string, lines: readonly string[], what: string, startsWith: string): string {
  const found = lines.find((line) => line.trim().startsWith(startsWith));
  if (found === undefined) {
    failures += 1;
    process.stdout.write(`  FAIL  ${file} no longer holds ${what}\n        looked for a line starting  ${startsWith}\n`);
    return "false # not found";
  }
  return found.trim();
}

/**
 * A run of lines, from one that starts with `startsWith` to the next line **at
 * the same indentation** whose trimmed text is `endsWith`.
 *
 * Deliberately not a brace matcher, and the indentation is what stands in for
 * one. It was "the next line that is exactly `endsWith`", which is only right
 * while the block is flat: the relay's start block in `install.sh` nests two
 * `if`s inside an `if`, so the first bare `fi` is an *inner* one and the
 * extraction stopped four lines early — with a syntactically valid fragment,
 * which is the way this goes wrong quietly rather than loudly.
 *
 * Every block extracted here is shell written in this repository's own style, so
 * an opener and its closer share a column; matching on that is exact for the
 * cases that exist and still refuses to guess at anything cleverer. Both
 * pre-existing callers were already terminated at their opener's own column
 * (`    fi` under `    if`, `  esac` under `  _rurl_host=`), so this narrows what
 * is accepted rather than widening it.
 */
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

/**
 * One arm of a `case`, from the line whose trimmed text is `<label>)` to the
 * `;;` that closes it.
 *
 * `blockIn` cannot reach these: an arm's closer sits two columns *deeper* than
 * its opener in this repository's style (`    daemon)` … `      ;;`), so the
 * same-column rule that makes `blockIn` exact for a function or an `if` finds
 * nothing here. The closer is found by that indentation rather than as the next
 * `;;` at all, because an arm may hold a `case` of its own — `deploy.sh`'s daemon
 * arm switches on the daily-refresh switch — and the first `;;` after the opener
 * is then the inner arm's, which cut the extract off before the call it was
 * meant to reach. Empty on a miss rather than a placeholder, because every caller
 * goes on to assert something the arm contains — and an empty string contains
 * none of it.
 */
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

/**
 * A line `main.ts` prints on the one start that bootstraps an admin, with its
 * interpolations filled in.
 *
 * The marker strings are read out of the source for the same reason the `awk` is
 * read out of `install.sh`: a scrape and the thing it scrapes are one contract
 * written in two files, and this driver is only worth having if it is the one
 * place they meet. Copying either would make this file a third opinion.
 */
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

/**
 * The block as a supervisor's log holds it.
 *
 * `svc_log_lines control-plane` is `compose logs --no-log-prefix`, and
 * `service_backend control-plane` is asserted to be `docker` above — which is
 * what makes the installer's `^ *` anchor safe. It is *not* safe against a
 * journal prefix, and the only reason that does not matter is that this service
 * has no unit; said here rather than discovered if it ever gets one.
 */
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

  /*
   * **The arm that shipped broken.** `main.ts` now prints a different *prefix*
   * (`admin password source: `) and the scrape now requires a *value*
   * (`[^ ]+$`); this is the assertion that either alone would satisfy, driven
   * against both. What must never come back is a word out of a sentence.
   */
  const supplied = scrape(bootstrapLog("admin", keyLine, passwordSourceLine));
  check("a supplied password yields no scraped password at all", supplied.pw, "");
  check("the source marker is what says so instead", supplied.src, "1");
  check("and the key is still read on that arm", supplied.key, BOOTSTRAP_KEY);
  check("main.ts's second arm no longer carries the marker that means a value follows", /^ *admin password: /.test(passwordSourceLine), false);

  /*
   * The literal that used to be printed there, kept as a literal on purpose:
   * the string no longer exists in `main.ts`, so there is nothing to extract,
   * and what this pins is the *scrape's* half of the fix independently of the
   * wording. `$NF` on it is the word `printed)`, which is what an operator was
   * told to sign in with.
   */
  const historic = scrape(bootstrapLog("admin", keyLine, "  admin password: taken from REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD (not printed)"));
  check("a marker line carrying a sentence rather than a value scrapes to nothing", historic.pw, "");
  check("and never to the last word of that sentence", historic.pw === "printed)", false);

  /*
   * `REEMOAT_CP_BOOTSTRAP_ADMIN` is operator-controlled and printed on a line
   * of its own, which is why both patterns are anchored to the start of a line.
   *
   * **The injected line goes last, and that ordering is the case rather than a
   * detail.** Both scrapes end in `tail -1`, so only a *later* line can win —
   * measured, a hostile name written above the real credentials scrapes to the
   * real values under the unanchored pattern too, i.e. a fixture in the order
   * `main.ts` happens to print is green against the bug and proves nothing.
   * With it below, the unanchored form returns `(u_deploycheck)` for both
   * markers and the anchored form returns neither. What is being asserted is
   * that position cannot decide this, which is the property an anchor has and a
   * substring match does not.
   */
  const hostileName = "x API key: rk_evil admin password: not-a-password";
  const hostile = scrape(
    ["", keyLine, passwordLine, shownOnceLine, printedLine("the bootstrapped-user line", "bootstrapped admin user", { name: hostileName }), ""].join("\n"),
  );
  check("a name carrying both markers feeds neither scrape, wherever it lands", [hostile.key, hostile.pw], [BOOTSTRAP_KEY, BOOTSTRAP_PASSWORD]);
  check("and the source marker is not fooled by it either", hostile.src, "");
}

/* ------------------------------------------------------------------ *
 * The loop that waits for both of them
 * ------------------------------------------------------------------ */

process.stdout.write("\nwaiting for the second line to arrive\n");

const breakLine = installLine("the capture loop's exit condition", 'if [ -n "$_key" ]');

/**
 * One iteration of the capture loop, with the three variables it decides on set
 * by hand. `for` because `break` outside a loop is not a statement.
 */
function loopDecision(key: string, pw: string, src: string): string {
  return sh(
    ['_key="$K"; _pw="$P"; _pw_src="$S"', "for _once in 1; do", breakLine, "  printf keep-waiting", "  exit 0", "done", "printf broke"].join("\n"),
    { K: key, P: pw, S: src },
  ).out;
}

check("both lines present is the ordinary exit", loopDecision(BOOTSTRAP_KEY, BOOTSTRAP_PASSWORD, ""), "broke");
/*
 * **The race this used to lose.** `main.ts` writes the key line and *then* the
 * password line, and the window is not the microsecond between two
 * `console.log`s — it is however long the container's log transport takes to
 * make the second one readable. Breaking on the key alone left `$_pw` empty
 * with nothing to recover it from: the password is written to no file, and the
 * report is gated on it being non-empty, so it was lost with nothing printed.
 */
check("a key with no password yet keeps waiting", loopDecision(BOOTSTRAP_KEY, "", ""), "keep-waiting");
/*
 * And the other way, which is why the condition is not simply "both": with
 * `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` set there is no password line coming,
 * so requiring one would spend the whole sixty seconds waiting for it.
 */
check("a key beside the source marker is enough, because no password is coming", loopDecision(BOOTSTRAP_KEY, "", "1"), "broke");
check("a password with no key yet keeps waiting too", loopDecision("", BOOTSTRAP_PASSWORD, ""), "keep-waiting");
check("and an empty log waits", loopDecision("", "", ""), "keep-waiting");

/* ------------------------------------------------------------------ *
 * What it then tells the operator
 * ------------------------------------------------------------------ */

process.stdout.write("\nreporting a credential, or its absence\n");

const reportBlock = installBlock("the three-outcome password report", 'if [ -n "$_pw" ]; then', "fi");

/** The report block, with everything it reads supplied. */
function report(pw: string, src: string): string {
  return sh(
    ['_pw="$P"; _pw_src="$S"; _cp_ui="https://cp.example"; _admin_name=admin; ENV_FILE=/dev/null', reportBlock].join("\n"),
    { P: pw, S: src },
  ).out;
}

check("a scraped password is printed under the marker", report(BOOTSTRAP_PASSWORD, "").includes(`admin password: ${BOOTSTRAP_PASSWORD}`), true);

{
  /*
   * The marker discipline applies to what this script prints as well, and it is
   * the same rule read from the other end: `admin password: ` appears on exactly
   * one line of this output, the one carrying the password. The other two arms
   * use a different prefix so that anything grepping this — including a future
   * version of `install.sh` — cannot scrape a sentence and call it a credential.
   */
  const supplied = report("", "1");
  check("a supplied password says where it came from", supplied.includes("admin password source:"), true);
  check("without writing the marker that promises a value", supplied.includes("admin password: "), false);

  /*
   * The third outcome, which used to be no outcome at all: the block was one
   * `if [ -n "$_pw" ]`, so a lost password printed nothing whatsoever and the
   * script exited 0. An empty `$_pw` must reach a sentence, never the marker.
   */
  const lost = report("", "");
  check("a password that never arrived is never printed as an empty one", lost.includes("admin password: "), false);
  check("it says the line did not appear", /did not appear/.test(lost), true);
  /*
   * **This assertion went red on purpose and was fixed here rather than there.**
   *
   * It used to require the sentence `cpctl admin passwd`, which was the way back
   * from a lost admin password until an admin stopped being able to set anybody
   * else's. The cheapest way to make it green again was to leave the string in
   * `install.sh` — and that is precisely how you ship an installer that prints a
   * remedy nobody can run, on the one screen somebody reads when nobody can sign
   * in.
   *
   * What is required now is that the branch names the remedy that exists and
   * does **not** name either deleted command.
   */
  check("and names a way back that still exists", /Settings → Server settings|reset link/.test(lost), true);
  check("and names neither deleted command", /admin passwd|admin key/.test(lost), false);
}

/* ------------------------------------------------------------------ *
 * Creating the first person, and not consuming their password
 * ------------------------------------------------------------------ */

process.stdout.write("\ncreating the first person\n");

{
  /*
   * `cpctl admin adduser … --json | json_field id` consumed the whole object to
   * pull one scalar out of it, and the object's other field is a one-time
   * password stored only as a hash. The line under it then said the password
   * "was printed above", which was never true on that path: `--json` prints the
   * object and nothing else, and the object went into the pipe. So the wizard
   * created somebody with no way to sign in and told the operator they had one.
   *
   * `cpctl` is stubbed, and that is the whole of what this does not cover: the
   * real one needs a control plane, an admin key and a network. What is under
   * test is what the script does with the answer, which is where it went wrong.
   */
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

  /*
   * The control plane's own first-person block reads **two** fields, and it used
   * to read a third. The capture above it sits inside a `confirm`, so `$_created`
   * is supplied here rather than extracted — the readers are the shipped lines.
   *
   * The third was `apiKey`, and it went with `--with-key` and the route branch
   * behind it: `POST /v1/admin/users` cannot return that field any more, so the
   * reader and the `[ -n "$_akey" ]` line under it were printing a value that
   * could never exist. This case shrank rather than being deleted, because what
   * is worth pinning is that the two survivors still work — a fixture that still
   * *carries* `apiKey` is deliberate, since the installer must ignore a field a
   * rolled-forward control plane might one day add rather than break on it.
   */
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

  /*
   * The deletion itself, because a deletion claim needs proving — and because
   * this is the file that would otherwise go green on an installer printing a
   * credential nothing can mint. Both halves: nothing reads the field, and
   * nothing prints the variable that used to hold it.
   */
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

  /*
   * The shape rather than the behaviour, because the two cases above can only
   * see the lines they extracted: a *new* call site written as a pipe would be
   * the same defect and neither would notice it.
   *
   * Comments are skipped, and the first run of this case is why — it went red on
   * `install.sh`'s own account of the defect, which quotes the broken pipeline
   * verbatim beside the fix. A check that forces that paragraph to be deleted or
   * reworded is a check against writing down what went wrong.
   */
  const piped = installLines.filter(
    (line) => !line.trim().startsWith("#") && /cpctl admin adduser.*\|\s*json_field/.test(line),
  );
  check("and no adduser response anywhere is read through a pipe that consumes it", piped, []);
}

/* ------------------------------------------------------------------ *
 * The URL every daemon in the fleet dials
 *
 * `REEMOAT_CP_RELAY_URL` is the one value here whose default was built out of a
 * variable nothing in this tree assigns. `${_lan:-$_host}` always took `$_host`
 * — the *API* publish address — so the relay address the operator had just
 * chosen, one prompt earlier, was ignored.
 *
 * That is not a hypothetical pairing: the interview offers "this machine only
 * (127.0.0.1) — safest" first for the API, then tells the operator that the
 * relay's loopback "reaches only daemons on this host". Taking both hints offers
 * `http://127.0.0.1:7889`, and one Enter writes it. The relay is the only way in
 * and `/v1/enroll` hands this URL to every daemon that enrolls, which persists it
 * — so the blast radius is the fleet, and the remedy is not an edit to this file
 * but a freshly minted enrollment code per machine, codes being single-use.
 *
 * Driven rather than restated: the shipped `case` and the shipped `ask` line are
 * extracted and run, with `lan_address` stubbed because it needs a route table.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe URL daemons will dial\n");

{
  const relayCase = installBlock("the relay URL's default", "_rurl_host=$_rhost", "esac");
  const relayPick = installBlock("the default it settles on", "_rurl_name=$(host_name)", "fi");
  const relayAsk = installLine("the prompt that offers it", '_rurl=$(ask "URL daemons will dial"');

  /**
   * The default `install.sh` would put in the brackets, for one set of answers.
   *
   * `exec </dev/null` is what makes `ask` return its default instead of blocking:
   * `IFS= read -r` fails at EOF and the function falls through to `${2:-}`. The
   * default is the whole of what is being measured — a typed answer needs a human
   * and stays uncovered, as the header says.
   *
   * `host_name` is stubbed beside `lan_address` because it asks the resolver, and
   * the whole point of the block below is which of the two answers wins.
   */
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

  /*
   * ⚠ **The one-way door, and this driver used to hold it open.**
   *
   * `deploy/RELAYS.md` opens by saying this value must be a name you control over
   * `https://`, because it is written into every daemon's `identity.relay_url` at
   * enrollment and changing it costs a single-use code typed on every machine in
   * the fleet. The prompt offered `http://<ip>:<port>`, one Enter took it, and
   * the case below **asserted that offer** — so the repository's own driver
   * pinned the answer its own document forbids, and the local instance this was
   * found on carries `http://192.0.2.10:7889` to this day.
   *
   * Two permanent costs, not one. An address cannot be re-pointed, so there is no
   * load balancer and no second relay without re-enrolling; and `http` is not
   * merely unencrypted, because `machine.ts` derives the socket scheme from this
   * value and anything that is not `https:` becomes a plaintext `ws:` carrying
   * `?token=`.
   */
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

  /*
   * The fallback, kept rather than made a refusal: a wizard that cannot finish on
   * a host with no DNS name is a wizard nobody can finish, and this is a real
   * shape — a Mac on a LAN, a box behind Tailscale. What changed is that it is
   * offered with the sentence saying what it costs, which is asserted below.
   *
   * Every case here is the *old* behaviour, unchanged, because it is still right
   * when there is nothing better to offer.
   */
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

  /*
   * The three wildcards, which are the one branch that still has to guess,
   * because a wildcard bind is not an address anybody can dial. All three arms
   * of the `case`, since a pattern list is exactly where an arm goes missing
   * without anything noticing.
   */
  for (const wildcard of ["0.0.0.0", "*", "::"] as const) {
    check(
      `a relay bound to ${wildcard} falls back to the default-route address`,
      relayDefault(wildcard, "127.0.0.1", "192.168.1.5"),
      "http://192.168.1.5:7889",
    );
  }
  /*
   * And behind that, `$_host` — the address the operator has already confirmed
   * once — because `lan_address` answers nothing on a host with no default
   * route, and an empty one would offer `http://:7889`.
   */
  check(
    "and behind that the address already confirmed for the API",
    relayDefault("0.0.0.0", "203.0.113.9", ""),
    "http://203.0.113.9:7889",
  );

  /*
   * `host_name` itself, which is where the *wrong* kind of name would get in.
   * A bare label (`ubuntu`, a Mac's own short name) and an mDNS `.local` both
   * look like names and resolve for nobody outside that LAN — so either would be
   * a worse default than the address it replaces, and worse in the way that
   * survives a prompt, because it looks correct.
   */
  const hostNameWith = (answer: string): string =>
    sh(`hostname() { printf '%s\\n' "$ANSWER"; }\nhost_name`, { ANSWER: answer }).out;
  check("a dotted name is a name", hostNameWith("relay.example.com"), "relay.example.com");
  check("a bare label is not", hostNameWith("ubuntu"), "");
  check("and neither is mDNS", hostNameWith("laptop.local"), "");
  check("nor is nothing at all", hostNameWith(""), "");

  /*
   * And the sentence, because a default nobody is warned about is the same trap
   * one step quieter. Asserted on the shipped text rather than restated.
   */
  const warned = installLines.filter((line) => line.includes("every machine in the fleet, by hand"));
  check("the prompt says what changing it later costs", warned.length, 1);

  /*
   * The shape as well as the behaviour, because the cases above can only see the
   * lines they extracted: what was wrong was a *name*, `_lan`, that no assignment
   * in this tree ever gave a value, and under `${_lan:-…}` an unset variable is a
   * fallback rather than an error even with `set -u`. So the defect was invisible
   * to the shell, to `sh -n` and to everybody reading the line.
   *
   * Comments are skipped for the reason the `adduser` case gives: `install.sh`
   * now quotes the broken expression verbatim beside the fix, and a check that
   * forced that paragraph to be deleted would be a check against writing down
   * what went wrong.
   */
  const unassigned = installLines.filter((line) => !line.trim().startsWith("#") && /\$\{?_lan\b/.test(line));
  check("and no line builds a default out of a variable nothing assigns", unassigned, []);
}

/* ------------------------------------------------------------------ *
 * What the relay is made of
 *
 * `deploy.sh` recreates the relay container only when the image moved **and**
 * `RELAY_INPUTS` matched the diff. The `and` is the whole value of splitting the
 * relay out: without it a CSS change recreates the relay, drops every tunnel in
 * the fleet, and the split buys nothing while looking complete.
 *
 * The failure the other way is the silent one — a file the relay is built from
 * that the pattern does not name means a deploy that updates the API, leaves the
 * relay on old code, and says "the tunnels stay up" about a relay that should
 * have been replaced. Nothing would report it and nothing would look wrong.
 *
 * So the pattern is checked against the entry point's *own* imports rather than
 * against a transcription of them, exactly as `webcheck` reads `cpctl.ts` off
 * disk rather than restating what it does.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the relay is made of\n");

{
  const deployScript = readFileSync(join(deployDir, "deploy.sh"), "utf8");
  const assigned = /^RELAY_INPUTS='([^']*)'$/m.exec(deployScript);
  check("deploy.sh assigns RELAY_INPUTS as a single-quoted literal", assigned !== null, true);

  const pattern = new RegExp(assigned?.[1] ?? "(?!)");

  /*
   * A closure walk, not a parse. Relative specifiers only — a bare `node:` or a
   * package name is inside the image by other means — and `.js` back to `.ts`,
   * which is this repository's NodeNext convention.
   */
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

  /*
   * The two the walk cannot see, checked by hand because their absence would be
   * invisible to it. `schema.sql` is read through `new URL(…, import.meta.url)`
   * rather than imported, and it is the skew that fails at *runtime*: the relay
   * holds prepared statements against tables the API may have migrated. The
   * manifests decide what `tsx` and `node:sqlite` even are.
   */
  check("the schema is an input even though nothing imports it", pattern.test("packages/control-plane/src/schema.sql"), true);
  check("and so are the manifests that decide what runs it", [
    pattern.test("package.json"),
    pattern.test("pnpm-lock.yaml"),
  ], [true, true]);

  /*
   * The other direction, and it is the one that pays: these are the ordinary
   * deploys. If any of them matched, the relay would be recreated for a change
   * it does not contain and every tunnel in the fleet would drop for it.
   */
  check("but a web-only change is not", [
    pattern.test("packages/web/src/ui/Composer.tsx"),
    pattern.test("packages/web/src/store.ts"),
  ], [false, false]);
  check("nor a route or a template on the API", [
    pattern.test("packages/control-plane/src/app.ts"),
    pattern.test("packages/control-plane/src/mail/templates.ts"),
  ], [false, false]);
  /*
   * **`settings.ts` used to be on the other side of this line and is not any
   * more**, and the reversal is worth stating rather than quietly re-listed.
   *
   * It was asserted as API-only on the strength of nothing in the relay reading
   * a setting — true until the machine limit, which the relay enforces itself:
   * `relay/authorize.ts` refuses a machine past its owner's limit before a byte
   * enters the tunnel, and `quota.ts` resolves that limit through `readInteger`.
   * So a relay left running the old `settings.ts` would enforce a different
   * number from the API, silently, which is exactly the skew `RELAY_INPUTS`
   * exists to prevent.
   *
   * The alternative was to keep the closure small by reading `instance_settings`
   * directly in `quota.ts` — rejected, because the row-wins/env-fallback rule
   * would then have two implementations, which is the coupling `settings.ts`'s
   * own header exists to refuse. The cost is that an SMTP-shaped change to that
   * file now drops the fleet's tunnels; they reconnect themselves, and the
   * alternative was a wrong answer nobody would see.
   */
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

/* ------------------------------------------------------------------ *
 * What a deploy says a restart will cost
 *
 * The one place this script tells an operator what they are about to lose, and
 * with a third service it said two false things at once. The arm was
 * `if daemon … else`, so recreating the *relay* printed "restart: control-plane"
 * — the wrong name — and attributed dropped tunnels to the control plane, which
 * is backwards after the split: the API holds no tunnel and the relay holds
 * every one of them. A deploy touching both printed the identical line twice.
 *
 * Nothing failed and nothing looked wrong, which is why it is driven rather than
 * read: the shipped block is extracted and run once per member of `SERVICES`, so
 * an arm that goes missing, a name that stops matching, or a catch-all that
 * quietly answers for a service it is not about all go red.
 * ------------------------------------------------------------------ */

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
  /*
   * The half that was wrong. `restart: <svc> ` as a prefix is the whole
   * assertion: the old `else` printed `restart: control-plane — …` for the
   * relay, which fails this and nothing else.
   */
  check(
    "and each names the service it is about",
    services.map((svc) => (announced(svc)[0] ?? "").startsWith(`restart: ${svc} `)),
    services.map(() => true),
  );
  check("so no two of them say the same thing", new Set(services.map((svc) => announced(svc)[0])).size, services.length);

  /*
   * No catch-all, asserted from outside rather than by reading for an `else`.
   * A `*)` arm is how the next service to arrive gets somebody else's sentence
   * instead of a red run — which is exactly how this one arrived.
   */
  check("and a name that is no service announces nothing at all", announced("nonesuch"), []);

  /*
   * The meaning, not just the label. "drop" is the word that carries the cost,
   * and it was on the wrong service: after the split the relay is the only thing
   * whose recreation drops a tunnel, and saying it about the API is what would
   * make somebody wait out a deploy that costs nothing.
   */
  const saysTunnelsDrop = (svc: string): boolean => /\bdrops?\b/i.test(announced(svc).join(" "));
  check("the relay's line is the one that says tunnels drop", saysTunnelsDrop("relay"), true);
  check("and the control plane's does not, because after the split it does not", saysTunnelsDrop("control-plane"), false);
}

/* ------------------------------------------------------------------ *
 * What a deploy does to the agents, before it decides on a restart
 *
 * `pnpm install` brings no coding agent (Q4.114), so a daemon upgraded from a
 * release that vendored them under `node_modules` would come back up with no
 * `claude` and no `codex` — every interrupted session on those harnesses
 * refused by `autoResume` — until its own first run, five minutes after start.
 * So the daemon arm runs `deploy/agents.sh` itself, before the restart
 * decision, with the source the daemon will use read off its env file and every
 * prune withheld, since this script cannot know which harnesses have a live
 * agent and the daemon's next run can.
 *
 * Read for its shape and then run, with a stub in the script's place recording
 * what reached it — the same split the restart announcement takes above. What
 * the stub cannot say is whether the real script does the right thing with
 * those arguments; that is the section on `agents.sh` itself.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a deploy does to the agents\n");

{
  const daemonArm = armOf(deployBlock("the per-service case", 'case "$svc" in', "esac"), "daemon");
  check("deploy.sh has a daemon arm", daemonArm.length > 0, true);
  // Continuation lines joined, so the call and its `||` read as the one
  // statement they are.
  const armLines = daemonArm
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const envAt = armLines.indexOf("_daemon_env=$(env_file daemon)");
  const readsOff = armLines.indexOf(`_agent_updates=$(file_value "$_daemon_env" REEMOAT_AGENT_UPDATES | tr '[:upper:]' '[:lower:]')`);
  const offArm = armLines.indexOf("off | 0 | false | no | never)");
  // Lowercased like the switch above it: the daemon's `agentSourceFrom` lowercases,
  // and a deploy that did not read `NPM` as npm ran the other arm off the same file.
  const readsSource = armLines.indexOf(`_agent_source=$(file_value "$_daemon_env" REEMOAT_AGENT_SOURCE | tr '[:upper:]' '[:lower:]')`);
  const defaults = armLines.indexOf('[ "$_agent_source" = npm ] || _agent_source=vendor');
  const announces = armLines.indexOf('echo "  agents ($_agent_source)"');
  const callAt = armLines.findIndex((line) => line.startsWith('"$REPO_ROOT/deploy/agents.sh" --source "$_agent_source"'));
  const call = armLines[callAt] ?? "";
  const guardAt = armLines.indexOf(') || echo "  agents: the script did not finish; the daemon retries daily" >&2');
  const restartAt = armLines.findIndex((line) => line.startsWith("restart_list="));
  check("the daemon arm reads the daemon's env file once, and the daily switch off it first", [envAt !== -1, readsOff === envAt + 1], [true, true]);
  /*
   * The daemon's own spellings of "off", read here as text rather than imported:
   * `AGENT_UPDATES_OFF` lives in `scripts/daemon.ts`, an entry script this driver
   * does not load, so the two lists are held together by this line.
   */
  const daemonTs = readFileSync(join(repoRoot, "scripts/daemon.ts"), "utf8");
  const offSpellings = /AGENT_UPDATES_OFF: ReadonlySet<string> = new Set\(\[([^\]]+)\]\)/.exec(daemonTs)?.[1]?.match(/"([^"]+)"/g)?.map((one) => one.slice(1, -1)) ?? [];
  check("and honours every spelling the daemon reads as off", [offArm !== -1, offSpellings.length > 0, offSpellings.filter((one) => !(armLines[offArm] ?? "").split(/\s*\|\s*/).map((w) => w.replace(/\)$/, "")).includes(one))], [true, true, []]);
  check("then reads the source off the same file, and defaults it to vendor", [readsSource > offArm, defaults === readsSource + 1], [true, true]);
  check("and the two override variables, which the daemon's own run would see", [armLines.indexOf('_agent_claude=$(file_value "$_daemon_env" CLAUDE_CODE_EXECUTABLE)') > defaults, armLines.indexOf('_agent_codex=$(file_value "$_daemon_env" CODEX_PATH)') > defaults], [true, true]);
  check("says which, then runs the same script the bootstrap and the daemon run, with that source", [announces > defaults, callAt > announces], [true, true]);
  check("with node's directory in front, as the bootstrap puts it", armLines.some((line) => line.startsWith('PATH="${NODE_BIN:+$(dirname -- "$NODE_BIN"):}$PATH"')), true);
  check("withholding every prune, since it cannot know which harnesses are live", AGENT_IDS.filter((id) => !call.includes(` --skip ${id}`)), []);
  check("with exactly one --skip per harness", (call.match(/ --skip /g) ?? []).length, AGENT_IDS.length);
  check("never fatal, and saying who retries", guardAt === callAt + 1, true);
  check("before the restart decision, so the copies are there when the daemon comes back", callAt !== -1 && restartAt > callAt, true);
  check("and this is the only place deploy.sh reaches the script", deployLines.filter((line) => !/^\s*#/.test(line) && line.includes("deploy/agents.sh")).length, 1);

  /*
   * Run against a stub `agents.sh` under a fake `REPO_ROOT`, with `touched`
   * answering "nothing moved" so the arm has nothing else to do. `lib.sh` runs
   * under `set -eu`, which is what makes the failing case an assertion rather
   * than a courtesy: without the `|| echo`, a stub exiting 1 would end the deploy
   * mid-loop, after the checkout had already moved.
   */
  const fakeRoot = join(sandbox, "deploy-root");
  const argvLog = join(fakeRoot, "agents-argv");
  const seenLog = join(fakeRoot, "agents-env");
  mkdirSync(join(fakeRoot, "deploy"), { recursive: true });
  const runArm = (env: Record<string, string>, exitWith = 0): { run: Run; argv: string; seen: string } => {
    // The stub records its argv, and the three things the arm has to hand it
    // through the environment rather than the command line.
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
  /*
   * The argv as what it means rather than as a string: one source, and the set
   * of harnesses skipped. The script reads `--skip` into a set too, so the order
   * the call spells them in is nothing it is held to — and `AGENT_IDS` is in a
   * different order, which a string comparison would have pinned by accident.
   */
  const meaning = (argv: string): { source: string | undefined; skips: string[]; rest: string[] } => {
    const tokens = argv.split(" ").filter((one) => one.length > 0);
    const out: { source: string | undefined; skips: string[]; rest: string[] } = { source: undefined, skips: [], rest: [] };
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === "--source") out.source = tokens[++i];
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
    "an env file saying npm runs the script with --source npm and every prune withheld",
    [npmDeploy.run.status, meaning(npmDeploy.argv), npmDeploy.run.out.includes("  agents (npm)\n"), npmDeploy.run.err],
    [0, { source: "npm", skips: everyHarness, rest: [] }, true, ""],
  );
  check("and adds nothing to the restart list by itself", npmDeploy.run.out.includes("restart_list=[]\n"), true);
  const noEnv = runArm({ REEMOAT_ENV_FILE: envSaying(null) });
  check(
    "no env file at all is vendor, which is what the daemon reads an absent value as",
    [noEnv.run.status, meaning(noEnv.argv), noEnv.run.out.includes("  agents (vendor)\n")],
    [0, { source: "vendor", skips: everyHarness, rest: [] }, true],
  );
  /*
   * A spelling the daemon would warn about and read as `vendor` is passed as
   * `vendor` here too — `agentSourceFrom` in `src/agentupdate.ts` is the rule,
   * and the script itself would exit 2 on the raw value, which the `|| echo`
   * would then report as a run that did not finish.
   */
  const bogus = runArm({ REEMOAT_ENV_FILE: envSaying("bogus") });
  check("and a spelling that is neither is passed as vendor rather than as itself", [bogus.run.status, meaning(bogus.argv)], [0, { source: "vendor", skips: everyHarness, rest: [] }]);
  const failed = runArm({ REEMOAT_ENV_FILE: envSaying("npm") }, 1);
  check(
    "a script that did not finish is a line on stderr, and the deploy goes on",
    [failed.run.status, failed.run.err.includes("agents: the script did not finish; the daemon retries daily"), failed.run.out.includes("restart_list=[]\n")],
    [0, true, true],
  );
  /*
   * The daily switch, the overrides and node's directory, each read off the same
   * file or shell the daemon's own run would see — and each with a measured cost
   * when missed: the vendors' installers run on a machine somebody switched off,
   * a ~200 MB claude installed beside an override nothing runs, and an npm arm
   * with no `npm` under `--node`.
   */
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

/* ------------------------------------------------------------------ *
 * The one-time admin key, and what may not close the door on it
 *
 * `START_FAILED` gates the admin-key capture, and that gate means one thing:
 * "the control plane never came up, so there is no `API key:` line coming". The
 * relay's start block was written into the same variable — so a relay that would
 * not bind skipped the capture over a control plane that was up, had minted the
 * admin user, and had printed the key once into a log bounded at 10m × 5 and
 * deleted outright by `compose down`. The rerun cannot recover it: `users` is no
 * longer empty and no key is ever printed again.
 *
 * Driven both ways, because the gate has a real job that must survive the fix —
 * a control plane that genuinely did not start must still close it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat may close the door on the one-time key\n");

{
  const relayStart = installBlock(
    "the relay's own start",
    'if [ "$SERVICE" = control-plane ] && [ "$START_FAILED" = "0" ]; then',
    "fi",
  );
  const keyGate = installLine("the admin-key gate", 'if [ "$SERVICE" = control-plane ] && [ ! -f "$CPCTL_ENV" ]');

  /**
   * Run the shipped relay block, then ask the shipped gate whether it is open.
   *
   * The gate line already carries its own `if … ; then`, so the arms are all
   * that has to be supplied here — which keeps the condition itself unrestated.
   */
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
  /* The defect, in one line: a relay that will not bind must not cost the key. */
  check("a relay that will not start does not close it", gateAfterRelay("0", "1", "0"), "GATE=open START=0 RELAY=1");
  check("nor does one that starts and will not answer", gateAfterRelay("0", "0", "1"), "GATE=open START=0 RELAY=1");
  /* And the job the gate is actually for, which the fix must not have removed. */
  check("but a control plane that never started still does", gateAfterRelay("1", "0", "0"), "GATE=shut START=1 RELAY=0");

  /*
   * The report at the end, where the same conflation sent an operator whose
   * relay was down to read the control plane's log — which is answering
   * perfectly. Two failures, two paragraphs, each naming its own logs.
   */
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
  /*
   * The half that was the bug: this paragraph is about `$SERVICE`, and printing
   * it over a control plane that is answering is what sent people to the wrong
   * log. Its absence is what tells an operator the API is fine, which is why the
   * relay's own paragraph must not claim that itself.
   */
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

/* ------------------------------------------------------------------ *
 * The sandbox held
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a runner does, driven without a runner\n");

/*
 * `deploy/ci-deploy.sh` is the half of a deploy that a CI job performs, and it
 * is a script rather than five `run:` blocks for one reason: a workflow file is
 * exercised by pushing and watching, so every decision inside one is unreachable
 * by any driver. `deploy.sh` had already written that rule down — keeping the
 * logic in a script is what lets it be tested by running it — and the first
 * version of `deploy.yml` broke it.
 *
 * Two seams make this drivable with no host, no network and no secrets. `SSH` is
 * what reaches the box, so `echo` turns the remote command into an assertion;
 * `GH` is how the commit's CI verdict is read, so a stub exercises both the green
 * and the red path. The same shape as `SmtpDialer` and `AgentProcess`.
 */
{
  const ciHome = tmp("cideploy-");
  const stubDir = join(ciHome, "bin");
  mkdirSync(stubDir, { recursive: true });

  /** A `gh` that answers whatever the case needs, without a network. */
  const ghStub = (verdict: string): string => {
    const path = join(stubDir, `gh-${verdict}`);
    writeFileSync(path, `#!/bin/sh\necho "${verdict}"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const run = (env: Record<string, string>): Run => {
    const result = spawnSync("sh", [join(repoRoot, "deploy", "ci-deploy.sh")], {
      cwd: deployDir,
      encoding: "utf8",
      env: {
        PATH: baseEnv.PATH,
        HOME: ciHome,
        SSH: "echo",
        SSH_KEYSCAN: "true",
        SSH_DIR: join(ciHome, "ssh"),
        GH: ghStub("success"),
        DEPLOY_HOST: "cp.example",
        DEPLOY_USER: "deployer",
        DEPLOY_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n",
        DEPLOY_REF: "abc123",
        ...env,
      },
    });
    return { status: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
  };

  /*
   * Every secret named, one at a time — because a guard that fires on "any of
   * them missing" passes just as well when it names the wrong one, and the whole
   * value of this step is that it says which.
   */
  for (const name of ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_KEY", "DEPLOY_REF"]) {
    const without = run({ [name]: "" });
    check(`a missing ${name} refuses before touching a host`, without.status, 2);
    check(`and names it`, without.err.includes(name), true);
  }
  // And says what to do instead, because the person reading it is mid-setup.
  check(
    "the refusal points at the manual path",
    run({ DEPLOY_HOST: "" }).err.includes("deploy/deploy.sh --ref"),
    true,
  );

  /*
   * **The daemon is not deployable from here**, and this is the assertion that
   * makes that a rule rather than an omission. `CLAUDE.md` records why: a daemon
   * restart leaves every live session `interrupted` and drops every pending
   * approval — the sessions come back, the work in them does not. A button that
   * can do that to somebody else's work should not exist.
   */
  const daemon = run({ DEPLOY_SERVICE: "daemon" });
  check("deploying a daemon from CI is refused", daemon.status, 2);
  check("and the refusal says what it would have cost", daemon.err.includes("pending approval"), true);
  check("while naming the path that is allowed to do it", daemon.err.includes("--service daemon"), true);

  /*
   * The gate. Pushing and then deploying before the run finishes is the one way
   * around the drivers, so a verdict that is not `success` stops here.
   */
  const red = run({ GH: ghStub("failure") });
  check("a commit whose checks failed is not deployed", red.status, 2);
  check("and the verdict is quoted rather than paraphrased", red.err.includes('"failure"'), true);
  const pending = run({ GH: ghStub("none") });
  check("nor one with no completed run at all", pending.status, 2);
  // The escape exists and is deliberately awkward, because sometimes you do mean
  // it — and a gate with no way past it gets deleted rather than skipped.
  const forced = run({ GH: ghStub("failure"), DEPLOY_SKIP_CHECK_GATE: "1" });
  check("saying so out loud gets past it", forced.status, 0);

  /*
   * The happy path, asserted on the *command* rather than on an exit code:
   * `SSH=echo` means the argv that would have reached the box is on stdout, so
   * this pins that CI calls `deploy.sh` rather than reimplementing it, with the
   * ref it was given and the one service it may touch.
   */
  const ok = run({});
  check("a green commit deploys", ok.status, 0);
  check(
    "by calling deploy.sh on the box, with the ref and the service",
    /deploy\/deploy\.sh --ref abc123 --service control-plane/.test(ok.out),
    true,
  );
  check("as the configured user on the configured host", ok.out.includes("deployer@cp.example"), true);
  check("with host-key checking left on", ok.out.includes("StrictHostKeyChecking=no"), false);
  check("and the directory overridable", run({ DEPLOY_DIR: "/srv/app" }).out.includes("cd /srv/app &&"), true);

  /*
   * The key never survives the run and never reaches the log. A key left on a
   * runner outlives the job on any host that reuses one, and a key echoed into
   * output outlives it everywhere.
   */
  check("the private key is not printed", ok.out.includes("BEGIN OPENSSH") || ok.err.includes("BEGIN OPENSSH"), false);
  check("and no key file is left behind", existsSync(join(ciHome, "ssh", "id_reemoat_deploy")), false);
}

/* ------------------------------------------------------------------ *
 * What a release does, driven without a registry
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a release does, driven without a registry\n");

/*
 * `deploy/ci-release.sh` is the same shape as `ci-deploy.sh` one act over, and it
 * is driven the same way. Three seams rather than two:
 *
 *   GH            the forge — the commit's CI verdict, and whether a release
 *                 already exists.
 *   DOCKER        everything that would reach a registry. `echo` turns the build
 *                 argv into an assertion.
 *   RELEASE_ROOT  the tree whose versions are read.
 *
 * That third one is what makes the interesting half testable at all. The script
 * refuses a tag that disagrees with any of six files, and each refusal has to
 * name *its own* file — a guard that fires on "something disagrees" is worth
 * much less, and there is no way to exercise six different disagreements
 * against the real repository without committing five deliberately-wrong
 * manifests. So each case gets a synthetic tree.
 *
 * The labels are the part worth being careful about. Asserting that the argv
 * contains `licenses=AGPL-3.0-only` proves nothing — a hardcoded string passes
 * it. Every label below is asserted by **mutating the fixture and watching the
 * label follow**, which is the only form that distinguishes derived from
 * transcribed, and derived is the whole reason the labels are not `LABEL` lines
 * in the Dockerfile.
 */
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

  /*
   * A `gh` whose `run list` answers a verdict, whose `release view` misses, and
   * whose `release create` succeeds.
   *
   * Keyed on `$1 $2` rather than on `$1`, and that is not fussiness: keyed on the
   * subcommand alone, `release view` and `release create` are the same arm, so a
   * stub saying "no such release" also makes creating one fail. The first version
   * did exactly that, and `publish` failed with status 1 in a case written to
   * prove it returns 0.
   */
  /*
   * ⚠ **`release create` echoes its argv, not a fixed word.** It answered
   * `created` and nothing else, which is enough to prove the verb ran and
   * nothing about *what it published* — and `publish` now uploads the installer
   * asset `README.md` tells strangers to download. Recording the command is the
   * same device `SSH=echo` and `dockerEcho` already use one screen up.
   */
  const gh = (verdict: string): string =>
    stub(
      `case "$1 $2" in\n` +
        `  "run list") echo "${verdict}" ;;\n` +
        `  "release view") exit 1 ;;\n` +
        `  "release create") echo "created $*" ;;\n` +
        `esac`,
    );

  /** A `gh` that also finds an existing release. */
  const ghWithRelease = stub(
    `case "$1 $2" in\n` +
      `  "run list") echo "success" ;;\n` +
      `  "release view") exit 0 ;;\n` +
      `  "release create") echo "created $*" ;;\n` +
      `esac`,
  );

  /**
   * A `docker` that echoes its argv and reports nothing published.
   *
   * The `--format` arm answers a digest, because `manifest` inspects the tag it
   * just created to get the attestation's subject — a stub that failed there
   * would make every manifest case look like a broken inspect.
   */
  const dockerEcho = stub(
    `case "$*" in\n` +
      `  *"imagetools inspect"*"--format"*) echo '"sha256:00ff"' ;;\n` +
      `  *"imagetools inspect"*) exit 1 ;;\n` +
      `  *) echo "docker $*" ;;\n` +
      `esac`,
  );

  /** A `docker` that finds the tag already published. */
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
  }

  /** A synthetic workspace with all six version sites, and nothing else. */
  const fixture = (t: Tree = {}): string => {
    const v = t.version ?? "0.1.0";
    const source = t.sourceUrl ?? "https://github.com/rends-east/reemoat";
    const dir = tmp("reltree-");
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    mkdirSync(join(dir, "packages", "control-plane", "src"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "deploy", "docker"), { recursive: true });
    // `publish` uploads this as the release's `install.sh` asset — the neutral
    // download source `README.md` points at — so a tree without one is a tree
    // that cannot be released, and the fixture has to carry it or every publish
    // case below fails for a reason that is not the case's subject.
    writeFileSync(join(dir, "deploy", "bootstrap.sh"), "#!/bin/sh\nmain() { :; }\nmain \"$@\"\n");

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

  /* What must be set, named one at a time — same reasoning as the deploy half. */
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

  /* A verb this script does not have is a typo, not a default. */
  check("an unknown verb is refused rather than assumed", release("frobnicate").status, 2);
  check("and so is no verb at all", release("").status, 2);

  /*
   * The tag is a version. The prerelease arm is a refusal *by name* rather than
   * silence: taking one means answering whether `latest` moves for it, whether
   * the release is flagged, and what the changelog heading looks like — none of
   * which is guessable from a script, and all of which is cheap once somebody
   * decides.
   */
  check("a tag that is not a version is refused", release("plan", { RELEASE_TAG: "nightly" }).status, 2);
  check("a tag missing its v is refused", release("plan", { RELEASE_TAG: "0.1.0" }).status, 2);
  check("a two-part version is refused", release("plan", { RELEASE_TAG: "v0.1" }).status, 2);
  const pre = release("plan", { RELEASE_TAG: "v0.2.0-rc.1" });
  check("a prerelease is refused by name rather than accepted quietly", pre.status, 2);
  check("and the refusal says what deciding it would cost", pre.err.includes("CHANGELOG"), true);

  /*
   * The tag against all six places the version is written, each named
   * individually. This is the assertion the `RELEASE_ROOT` seam exists for.
   *
   * `src/version.ts` is the sixth and was gated by nothing: `pincheck` asserts
   * it, and `RELEASE_SKIP_CHECK_GATE=1` is precisely the case where `pincheck`
   * never runs. What ships wrong then is what every machine reports about itself
   * into `cpctl admin fleet`, which a floor-raise is decided from.
   */
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

  /*
   * And a manifest whose version line stopped matching, which must fail as
   * loudly as one that disagrees — `pincheck`'s rule about `capture` returning
   * null, in shell. A pattern that silently reads "" and compares it to "" is the
   * one outcome worse than no check.
   */
  const reformatted = release("plan", {}, fixture({ rootManifest: `{"name":"reemoat","version" : "0.1.0"}` }));
  check("a manifest whose version line stopped matching fails as loudly", reformatted.status, 2);
  check("and says the pattern is what to fix", reformatted.err.includes("reformatted"), true);

  /* An empty changelog section, because the release page is that section. */
  const empty = release("plan", {}, fixture({ notes: "" }));
  check("a version with an empty CHANGELOG section is refused", empty.status, 2);

  /* The gate, in the four states the deploy half has. */
  const red = release("plan", { GH: gh("failure") });
  check("a commit whose checks failed is not released", red.status, 2);
  check("and the verdict is quoted rather than paraphrased", red.err.includes('"failure"'), true);
  check("nor one with no completed run at all", release("plan", { GH: gh("none") }).status, 2);
  check(
    "saying so out loud gets past it",
    release("plan", { GH: gh("failure"), RELEASE_SKIP_CHECK_GATE: "1" }).status,
    0,
  );

  /*
   * A re-release, refused on both halves. The second is the one that matters:
   * GitHub refuses to create a release twice, and **GHCR moves a tag without
   * complaining** — so publishing v0.1.0 again silently repoints a name somebody
   * has already pulled.
   */
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

  /*
   * ⚠ And that `publish` does **not** ask the image half, which is ordering
   * rather than a softer rule: `manifest` runs immediately before it and creates
   * exactly the tag that check looks for, so asking there would make the last
   * step of a successful release refuse the release it just built — a gate that
   * fires only when everything worked. Found by running it.
   */
  const publishWork = join(tmp("relpub-"), "w");
  mkdirSync(publishWork, { recursive: true });
  writeFileSync(join(publishWork, "notes.md"), "notes\n");
  check(
    "publish is not blocked by the image manifest just created",
    release("publish", { DOCKER: dockerPublished, RELEASE_WORK: publishWork }).status,
    0,
  );

  /* The computed tags. */
  const planned = release("plan");
  check("a green tag plans", planned.status, 0);
  check("the image is published under the expected name", planned.out.includes("ghcr.io/"), true);
  check("the version tag is the git tag verbatim", planned.out.includes("tag_version=") && planned.out.includes(":v0.1.0"), true);
  check("the commit gets a tag of its own, which is the one a rollback wants", /tag_sha=\S+:sha-abc123def456\b/.test(planned.out), true);
  check("latest is offered", planned.out.includes(":latest"), true);
  check("and withheld when it is asked to be", release("plan", { RELEASE_LATEST: "0" }).out.includes("tag_latest=\n"), true);
  /*
   * No rolling minor or major tag on a 0.x release. Under SemVer a 0.x *minor*
   * is the breaking one, so `:0` would mean "may break without warning" while
   * reading like stability.
   */
  check("there is no rolling minor tag", /:0\.1(\s|$)/.test(planned.out), false);
  check("nor a rolling major one", /:0(\s|$)/.test(planned.out), false);

  /*
   * The notes are the CHANGELOG section and stop where it does — including at
   * the link-reference block, which is what the newest release runs into
   * because it is the last section in the file. Measured: the first version of
   * the extraction shipped `[Unreleased]: https://…` as release notes.
   */
  const notesWork = join(tmp("relnotes-"), "w");
  const notesRun = release("plan", { RELEASE_WORK: notesWork });
  const notesText = readFileSync(join(notesWork, "notes.md"), "utf8");
  check("the notes carry the section somebody wrote", notesText.includes("The first one."), true);
  check("and stop before the link-reference block", notesText.includes("[Unreleased]:"), false);
  check("and before the next heading", notesText.includes("## ["), false);
  check("plan says where it put them", notesRun.out.includes("notes_file="), true);

  /*
   * The build argv. `DOCKER=echo`-shaped stub, so what would have reached a
   * registry is on stdout.
   */
  const built = release("image");
  const argv = built.out;
  check("the image build is buildx", argv.includes("buildx build"), true);
  check("built from the repository root with the same Dockerfile compose builds", argv.includes("deploy/docker/Dockerfile"), true);
  check("pushed by digest rather than by tag", argv.includes("push-by-digest=true"), true);
  check("and claiming no tag, so two architectures cannot race for one", argv.includes("--tag"), false);
  /*
   * ⚠ Never `--load`. `imagecheck` passes it and explains at length why it must
   * for a *local* build under the docker-container driver. This build's output is
   * a registry, where `--load` beside `push` is a contradiction — and copying
   * that flag across is the obvious mistake, which is why it is asserted rather
   * than trusted.
   */
  check("and never --load, which is imagecheck's requirement and not this one", argv.includes("--load"), false);
  check("the platform reaches the build unchanged", argv.includes("--platform linux/amd64"), true);
  check(
    "and is the one variable that decides the architectures",
    release("image", { RELEASE_PLATFORM: "linux/arm64" }).out.includes("--platform linux/arm64"),
    true,
  );
  check("buildx's own provenance export is off, since the attestation is the one mechanism", argv.includes("--provenance=false"), true);

  /*
   * Every label, proved by mutating the fixture and watching it follow. String
   * equality against a hardcoded expectation would pass just as well if the
   * script transcribed these instead of deriving them, which is the thing worth
   * knowing.
   */
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
  /*
   * And that `source` is read from the offer rather than from `repository.url`.
   * They are the same string in a healthy tree, so only a fixture where they
   * differ can tell which one the script actually used — and it matters, because
   * `app.ts` is what instructs a fork to change its section 13 source.
   */
  const offerLed = release("image", {}, fixture({ sourceUrl: "https://example.invalid/fork" })).out;
  check("the source label follows the section 13 offer specifically", offerLed.includes("image.source=https://example.invalid/fork"), true);

  /* The manifest verb. */
  const digestDir = join(tmp("reldigests-"), "d");
  mkdirSync(digestDir, { recursive: true });
  writeFileSync(join(digestDir, "linux-amd64"), "sha256:aa11\n");
  const merged = release("manifest", { RELEASE_DIGEST_DIR: digestDir });
  check("the final tags are created from digests rather than rebuilt", merged.out.includes("imagetools create"), true);
  check("naming every digest that was pushed", merged.out.includes("@sha256:aa11"), true);
  check("and it emits the index digest the attestation needs", merged.out.includes("digest=sha256:00ff"), true);
  /*
   * An empty digest directory is what a silently-skipped matrix leg looks like,
   * and merging nothing would publish tags resolving to nothing while every step
   * reported success.
   */
  const noDigests = join(tmp("relempty-"), "d");
  mkdirSync(noDigests, { recursive: true });
  check("and it refuses with no digests at all", release("manifest", { RELEASE_DIGEST_DIR: noDigests }).status, 2);

  /* The publish verb. */
  const published = release("publish", { RELEASE_WORK: publishWork });
  check("the release is created from the section somebody wrote", published.out.includes("publishing v0.1.0"), true);
  /*
   * **And it carries the installer.** `README.md`'s one-liner points at
   * `releases/latest/download/install.sh`, so a release published without that
   * asset is a URL that 404s for every reader — and nothing else would notice,
   * because the README, the release and the script are three files no compiler
   * relates. Asserted on the argv the `GH` seam records, and on the *published*
   * name rather than the file's own: `releases/latest/download/<name>` resolves
   * on the asset name, so `bootstrap.sh` reaching the release under that name
   * would be a working upload and a broken README.
   */
  check(
    "and the release carries the installer people are told to download",
    /release create[\s\S]*\/install\.sh/.test(published.out),
    true,
  );
  check("publish refuses when plan never wrote the notes", release("publish").status, 2);

  /*
   * Nothing leaks, and nothing is required that a laptop would not have.
   *
   * ⚠ **This searched for the string `GH_TOKEN` and could not fail.** That name
   * appears nowhere in `ci-release.sh` and was never in the child's environment,
   * so the check passed on a script that had no token to leak — and it would have
   * kept passing on one that did, because a leak prints the *value*. Driven with
   * a real variable holding a recognisable sentinel now, so the assertion is about
   * the script's handling of a token that exists.
   */
  const SENTINEL = "ghp_deploycheckSentinelMustNotBePrinted";
  const withToken = release("plan", { GH_TOKEN: SENTINEL, RELEASE_WORK: join(tmp("reltok-"), "w") });
  check("a forge token in the environment is not printed", withToken.out.includes(SENTINEL) || withToken.err.includes(SENTINEL), false);
  check("and the run that proves it actually succeeded", withToken.status, 0);
  check("and it runs with no GITHUB_OUTPUT to write to", planned.status, 0);
}

/* ------------------------------------------------------------------ *
 * What the freshness job does, driven without a registry
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the freshness job does, driven without a registry\n");

/*
 * `deploy/ci-freshness.sh` is the third `ci-*` script and the first whose
 * subject is not this tree but the registry's opinion of it: how far behind
 * `latest` each ACP adapter pin sits, and whether the pinned version is still
 * served at all. `pincheck` cannot answer either offline, and every step of
 * `check.yml`'s first job is offline by contract — so it is a workflow of its
 * own on a schedule, and the same shape as the other two: a checkout and one
 * call, with every decision in the script. Three seams:
 *
 *   NPM_VIEW              the registry. A stub answering canned versions per
 *                         package, so the five outcomes are five cases and none
 *                         of them opens a socket.
 *   FRESHNESS_ROOT        the tree whose `package.json` is read. Synthetic, so
 *                         "the report follows the pin" is a mutation and an
 *                         observation rather than string equality against the
 *                         real manifest — `labelFollows`'s argument one act over.
 *   FRESHNESS_MAX_BEHIND  the margin. Unset is the documented default and the
 *                         decision under test: behind is a report, and only this
 *                         variable makes it a refusal.
 *
 * And the workflow file, read here for the one property a workflow can be
 * checked for offline: that it decides nothing. `deploy.yml` and `release.yml`
 * state the same rule in their own headers and nothing had ever read either
 * back; this is the first of the three whose YAML is asserted, and the shape of
 * the assertion — every `run:` is the script and nothing else, no `if:`, no
 * trigger a push could fire — is the one the other two would take.
 */
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

  /**
   * An `npm view` that answers three questions per package and refuses any it
   * was not written for — so a script that started asking a fourth goes red
   * here rather than reaching the network on a runner. Keyed on `$1 $2` for the
   * reason the release stub gives: `versions` and `dist-tags.latest` are the
   * same package and must not share an arm.
   */
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

  /** A manifest carrying the given adapter pins beside things that are not adapters. */
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

  /*
   * The workflow decides nothing. Comments stripped first, since the header
   * names `push` and `if:` while explaining why neither is here.
   */
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

  /*
   * The pins are read off the tree rather than restated. Two halves: the real
   * manifest's adapters are what the script names, and a fixture whose pin moved
   * moves the report — the second being the only form that tells "derived" from
   * "transcribed".
   */
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

  /* Current: exit 0, one line each. */
  const green = freshness();
  check("two current pins exit 0", green.status, 0);
  check("naming each as current", [green.out.includes(`${CLAUDE}: 0.63.0 is current`), green.out.includes(`${CODEX}: 1.1.9 is current`)], [true, true]);

  /*
   * Behind: still exit 0, which is the decision. A weekly red for a pin somebody
   * has chosen not to move yet is a red that teaches people to ignore red. The
   * count is releases the registry lists after the pin, and the row reaches the
   * job summary when a runner provides one.
   */
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

  /* The margin, which is the only thing that makes behind a refusal. */
  const overMargin = freshness({ NPM_VIEW: moved, FRESHNESS_MAX_BEHIND: "1" });
  check("behind by more than FRESHNESS_MAX_BEHIND is refused", overMargin.status, 2);
  check("naming the variable", overMargin.err.includes("FRESHNESS_MAX_BEHIND"), true);
  check("while behind by exactly the margin is not", freshness({ NPM_VIEW: moved, FRESHNESS_MAX_BEHIND: "2" }).status, 0);
  check("and a margin that is not a count is refused before the registry is asked", freshness({ FRESHNESS_MAX_BEHIND: "lots" }).status, 2);

  /* Deprecated: reported, and not a failure — it still installs. */
  const deprecated = freshness({
    NPM_VIEW: registry({
      [CLAUDE]: { latest: "0.63.0", versions: ["0.63.0"], deprecated: "use 0.73.0" },
      [CODEX]: { latest: "1.1.9", versions: ["1.1.9"] },
    }),
  });
  check("a deprecated pin exits 0", deprecated.status, 0);
  check("and is reported with the registry's own message", deprecated.out.includes("deprecated: use 0.73.0"), true);

  /*
   * Unpublished: the one outcome that is nobody's choice. A version the registry
   * does not list fails `pnpm install --frozen-lockfile` on the next machine the
   * one-liner sets up, so this is a refusal — and every adapter is still reported
   * first, so one bad pin does not hide the state of the other.
   */
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
  /*
   * ⚠ Matched as the quoted string with its dots escaped. A bare `0.6.0` would
   * otherwise find itself inside `0.63.0` and call an unpublished pin published.
   */
  const prefix = freshness({ NPM_VIEW: registry({ [CLAUDE]: { latest: "0.63.0", versions: ["0.63.0"] }, [CODEX]: { latest: "1.1.9", versions: ["1.1.9"] } }) }, manifest({ [CLAUDE]: "0.6.0", [CODEX]: "1.1.9" }));
  check("a pin that is a prefix of a published version is not thereby published", prefix.status, 2);

  /*
   * Unreachable: a distinct code with a sentence, and npm's own stderr under it.
   * "The pin is bad" and "the network is down" answer different questions, and a
   * scheduled job reporting the second as the first sends somebody to edit a
   * manifest that is fine.
   */
  const down = freshness({ NPM_VIEW: stub(`echo "npm ERR! code ENOTFOUND registry.npmjs.org" >&2; exit 1`) });
  check("a registry that cannot be asked exits 3, not 2", down.status, 3);
  check("with a sentence saying it is about the run", down.err.includes("could not ask the registry"), true);
  check("carrying npm's own reason", down.err.includes("ENOTFOUND"), true);
  check("and never the word refusing, which is a verdict", down.err.includes("refusing"), false);
  const silent = freshness({ NPM_VIEW: stub(`case "$2" in dist-tags.latest) ;; versions) echo '["0.63.0"]' ;; deprecated) ;; esac`) });
  check("a registry that answers no latest at all is unreachable too", silent.status, 3);

  /* The manifest, and the shapes of it that are refused before the registry is asked. */
  const noPins = freshness({ NPM_VIEW: stub(`exit 9`) }, manifest({}));
  check("a manifest with no adapter pin is refused rather than reported green", noPins.status, 2);
  check("and says the pattern is what to fix", noPins.err.includes("pattern"), true);
  const ranged = freshness({ NPM_VIEW: stub(`exit 9`) }, manifest({ [CLAUDE]: "^0.63.0", [CODEX]: "1.1.9" }));
  check("a range is refused as not a pin", ranged.status, 2);
  check("naming the package", ranged.err.includes(CLAUDE) && ranged.err.includes("range"), true);
  check("a tree with no manifest is refused", freshness({ NPM_VIEW: stub(`exit 9`) }, tmp("freshempty-")).status, 2);
  check("and an argument is a usage error, since there are none", freshness({}, pinned(), "--check").status, 2);

  /* Nothing leaks: a registry token in the environment stays there. */
  const SENTINEL = "npm_deploycheckSentinelMustNotBePrinted";
  const withToken = freshness({ NPM_TOKEN: SENTINEL, NODE_AUTH_TOKEN: SENTINEL });
  check("a registry token in the environment is not printed", withToken.out.includes(SENTINEL) || withToken.err.includes(SENTINEL), false);
  check("and that run succeeded", withToken.status, 0);
}

/* ------------------------------------------------------------------ *
 * The one migration rule, asserted rather than asked for
 *
 * ⚠ **`migrate()`'s docblock said `deploycheck` asserted this and `deploycheck`
 * did not.** `grep "ALTER TABLE" scripts/` matched nothing, so the rule the whole
 * rollback story rests on — *additions only, and `CP_SCHEMA_VERSION` does not
 * move for them* — was enforced by a comment that advertised itself as
 * mechanised. That is the worst of the three states: a reader checking whether
 * the rule is enforced finds a sentence saying yes.
 *
 * Why it is worth a check rather than a promise: a nullable column an older build
 * never selects is invisible to it, so yesterday's image starts against today's
 * database and a rollback stays a rollback. A DROP or a RENAME breaks exactly
 * that, and a version bump beside an addition converts a working rollback into
 * `checkSchemaVersion` refusing the file, `main.ts` exiting 2, and the unit
 * restarting into a crash loop that takes the relay — and with it every machine's
 * reachability.
 *
 * Read off the source rather than by running it, because the property is about
 * statements that are not there.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the control plane's migration is allowed to do\n");
{
  const storeSource = readFileSync(join(repoRoot, "packages/control-plane/src/store.ts"), "utf8");

  /*
   * The function body, by brace balance from its own signature. An empty read has
   * to fail as loudly as a violation — `pincheck`'s rule about `capture` — because
   * a body this cannot find is a body it cannot check.
   */
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

  /*
   * Every SQL the migration names, matched on the literal rather than on the call
   * around it — `db.exec("...")` directly, or handed to the `addColumn` helper,
   * or to whatever wraps it next. A check keyed on `db.exec(` would have gone
   * quiet the moment those statements moved one function along, which is exactly
   * what happened when the duplicate-column guard was added.
   *
   * A SQL literal is one starting with an uppercase keyword and a space, which
   * separates the statements from the column names beside them.
   */
  const statements = [...body.matchAll(/"([A-Z]+ [^"]*)"/g)].map((m) => m[1] ?? "");
  check("the migration names some SQL at all", statements.length > 0, true);
  check(
    "and every statement it names is a read or an ADD COLUMN",
    statements.filter((sql) => !/^ALTER TABLE \w+ ADD COLUMN /.test(sql) && !/^PRAGMA \w+\(/.test(sql)),
    [],
  );
  /*
   * And that the helper still only executes what it was handed. If it ever grew a
   * literal of its own, the list above would stop being the whole set.
   */
  const helperStart = storeSource.indexOf("function addColumn(");
  const helper = storeSource.slice(helperStart, storeSource.indexOf("\n}\n", helperStart));
  check("the helper executes only the statement it was given", /db\.exec\(\s*"/.test(helper), false);
  check(
    "with no DROP and no RENAME anywhere in it",
    /\b(DROP|RENAME)\b/i.test(body),
    false,
  );

  /*
   * And the version that must not move for any of it. Stated as the literal here
   * on purpose: this is the one number whose *change* is the failure, so reading
   * it from the same file it guards would make the check agree with whatever it
   * found.
   */
  const declared = /export const CP_SCHEMA_VERSION = (\d+)/.exec(storeSource);
  check("CP_SCHEMA_VERSION is readable", declared !== null, true);
  check(
    "and has not moved, because an addition is invisible to an older build and must stay so",
    Number(declared?.[1] ?? -1),
    1,
  );
}

/* ------------------------------------------------------------------ *
 * The backup, which is the one failure here with no way back
 *
 * `signing_keys.private_pem` lives in a Docker named volume, and a daemon writes
 * `keys_json` once at enrollment and never refetches it — so losing that volume
 * is not a restore, it is a fresh enrollment code typed on every machine in the
 * fleet. The repository carried the right *technique* (five lines of
 * `VACUUM INTO` inside a section about Time Machine on macOS) and nothing that
 * ever ran it: no script, no timer, no CI step, and `deploy.sh` does not touch
 * the volume before swapping the image.
 *
 * Driven for the parts that need no Docker: that the script exists and is
 * executable, that it refuses what it should, and — the one that matters — that
 * its retention `rm` cannot reach a file it did not write.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe backup\n");

{
  const backup = join(deployDir, "backup.sh");
  check("there is a backup script at all", existsSync(backup), true);
  check("and it is executable", (statSync(backup).mode & 0o111) !== 0, true);

  const text = readFileSync(backup, "utf8");
  /*
   * **`VACUUM INTO`, never a copy.** The database is WAL, so the file on disk is
   * the database minus whatever is in `-wal`; a `cp` or a tar of the volume
   * restores as a corrupt page, and the failure surfaces on the day it is used.
   */
  check("it takes SQLite's own consistent snapshot", text.includes("VACUUM INTO"), true);
  check("and never tars or copies the volume out from under a live writer", /\bcp -r|tar .*var\/lib\/reemoat/.test(text), false);
  /*
   * A snapshot that was not verified is a file, not a backup — and an
   * unverifiable one that still gets counted is worse than none, because it is
   * the one somebody reaches for.
   */
  check("every snapshot is verified before it counts as one", text.includes("integrity_check"), true);
  check("and kept at 0600, like the database it came from", text.includes('chmod 600 "$OUT.part"'), true);
  /*
   * **The retention glob is the one `rm` in this file**, and it must not be able
   * to name anything this script did not write. `$DIR` is operator-supplied, so a
   * bare `$DIR/*` would delete whatever else lives there.
   */
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
  /*
   * Refused *before* anything is created, which is what keeps a typo from
   * leaving a 0700 directory somewhere the operator did not mean.
   */
  check("with nothing created on the way to the refusal", existsSync(join(home, ".reemoat", "backups")), false);
}

/* ------------------------------------------------------------------ *
 * Which image, and whether this host builds it or pulls it
 * ------------------------------------------------------------------ */

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

  /*
   * **The env file is consulted, and this is a fix rather than a feature.**
   * `deploy/README.md` told operators to put `REEMOAT_CP_IMAGE=ghcr.io/...` in
   * the control plane's env file, and it could never work: compose gives the
   * shell environment precedence over `--env-file` for `${...}` interpolation,
   * and `compose.sh` exported its own default before compose ever ran. Measured
   * — `deploy/compose.sh config` with a registry ref in that file still printed
   * `image: reemoat/control-plane:current`. The recipe was in the README from
   * the day the published image existed.
   */
  writeFileSync(cpEnv, "REEMOAT_CP_IMAGE='ghcr.io/rends-east/reemoat/control-plane:v0.4.0'\n", { mode: 0o600 });
  check("the env file is read when the environment is silent", ref(), "ghcr.io/rends-east/reemoat/control-plane:v0.4.0");
  check("and that is enough to put the host in pull mode", source(), "pull");
  // Precedence, not merger: an operator exporting a ref for one run is not
  // overridden by a file they are deliberately stepping around.
  check("but the environment still wins over it", ref({ REEMOAT_CP_IMAGE: "reemoat/control-plane:current" }), "reemoat/control-plane:current");

  /*
   * **An unrecognised override is refused rather than defaulted.** Silently
   * building where somebody asked to pull is the direction that hurts: it is a
   * host that has been quietly doing the expensive thing for weeks.
   */
  const bad = sh("cp_image_source", { REEMOAT_CP_SOURCE: "nonsense" });
  check("an unknown REEMOAT_CP_SOURCE is refused", bad.status, 2);
  check("naming what was typed", bad.err.includes("nonsense"), true);
  check("and the override is honoured when it is one of the two", source({ REEMOAT_CP_IMAGE: "ghcr.io/x/y:v1", REEMOAT_CP_SOURCE: "build" }), "build");

  /*
   * **One resolver, asserted as a fact about the source.** Two copies of the
   * default is what let a pull move the digest while `cp_image_fingerprint`
   * inspected a different name, reported "unchanged", and recreated nothing —
   * a deploy that printed success over the old bytes. Neither script may hold a
   * second copy of that literal.
   */
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
  /*
   * ⚠ **`cp_image_fingerprint` is what decides whether every relay tunnel in the
   * fleet drops**, through `CP_IMAGE_MOVED && touched "$RELAY_INPUTS"`. It
   * inspects the *local* image either way, so a pull needs no change there — but
   * only while it asks about the same name compose ran.
   */
  check(
    "including the fingerprint the relay recreate decision reads",
    /cp_image_fingerprint\(\)[\s\S]{0,400}cp_image_ref/.test(readFileSync(join(deployDir, "lib.sh"), "utf8")),
    true,
  );

  rmSync(cpEnv, { force: true });
}

/* ------------------------------------------------------------------ *
 * bootstrap.sh — the one-liner, and the four things about it that are
 * checkable without a network, a terminal or a supervisor
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe one-line installer\n");

{
  const bootstrapPath = join(deployDir, "bootstrap.sh");
  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const bootstrapLines = bootstrap.split("\n");
  // Comments are where the hosted example is *documented*, which is legitimate;
  // what must not exist is a host in code. Stripped the crude way on purpose —
  // a full-line `#` is the only comment form this file uses.
  const code = bootstrapLines.filter((line) => !/^\s*#/.test(line)).join("\n");

  /*
   * **The toolchain pins, tied to the repository rather than to memory.**
   *
   * This is the highest-value assertion in this section and the one with no
   * other witness. A bootstrap that installed pnpm 10 against a lockfile written
   * by 11.17.0 fails on a stranger's laptop, at `--frozen-lockfile`, minutes in —
   * and nothing else in this tree looks at these two lines. `pincheck` compares
   * the six *version* sites to each other and has never heard of this file.
   */
  /**
   * One `bootstrap.sh`, driven with **no controlling terminal**.
   *
   * ⚠ **`detached: true` is the whole point of this helper.** Every question in
   * that script is asked on fd 3, opened from `/dev/tty` — deliberately, because
   * stdin is the `curl` download — and a `spawnSync` child inherits its parent's
   * controlling terminal no matter what `stdio` says. Measured both ways through
   * a real pty: inherited, `sh bootstrap.sh` with no arguments **draws the
   * "Which control plane?" menu into the developer's own terminal and blocks
   * there for ever** — `pnpm deploycheck` hangs mid-run, and not even
   * `spawnSync`'s `timeout` gets it back; detached, the same run refuses with
   * status 2 and the sentence below. So the assertions here were true only
   * because CI and agents happen to have no tty, which is the shape of a test
   * that passes for a reason it does not state. `detached` calls `setsid`, the
   * child leads its own session, `/dev/tty` cannot be opened, and `TTY_OPEN=0`
   * is a fact rather than an accident of who ran the driver.
   */
  const runBootstrap = (args: string[], env: Record<string, string> = {}): Run => {
    // Held in a variable rather than written inline, and that is the cast: the
    // option is honoured by the implementation and missing from
    // `SpawnSyncOptions`, so a fresh object literal fails the excess-property
    // check while an assignable variable does not. Measured working; if a future
    // node drops it, the symptom is this driver hanging on a developer's
    // terminal and the fix is a `setsid`, not deleting the line.
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
  /*
   * Numbers, not strings. `">=24"` against `"24"` held by luck; `">=24.1"`
   * becomes `"241"`, and `"241" <= "24"` is false — a red build blaming the
   * bootstrap's pin for a manifest that got more precise.
   */
  const engineMajor = Number.parseInt(rootManifest.engines.node.replace(/[^\d.]/g, ""), 10);
  check(
    "and the node it installs satisfies engines.node",
    Number.parseInt(pinned("NODE_MAJOR"), 10) >= engineMajor,
    true,
  );

  /*
   * **No control plane is written down here.** The script defaults to whichever
   * instance served it and has no fallback constant — a self-hosted operator
   * whose installer quietly pointed at somebody else's fleet is the worst
   * outcome this feature has available, and it is one careless line away. Only
   * nodejs.org may appear, and only for the toolchain download.
   */
  const urls = [...code.matchAll(/https:\/\/[^\s"'`$)\\]+/g)].map((m) => m[0]);
  /*
   * A *host*, not a URL. `https://<control-plane>` and the `https://*` in a
   * `case` glob are the script saying "wherever you fetched this from" and are
   * the point rather than a violation; what may not appear is something a
   * resolver would answer for. So the test is a dotted authority, which is what
   * separates the two.
   */
  const hosts = urls.filter((u) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i.test(u));
  /*
   * ⚠ **Named in prose is allowed; used as a value is not**, and the difference
   * is the whole decision. The script *tells* somebody the author runs a control
   * plane at a particular address, because otherwise finding it is a research
   * task. What it may never do is put that address into a variable, a default or
   * a request — a download URL says where the software is, and letting it also
   * decide which fleet a machine joins is how a self-hoster's laptop ends up
   * somewhere they did not choose. So the test is not "is the host mentioned"
   * but "is it on a line that could act on it".
   */
  const namesHost = (line: string): boolean =>
    !/^\s*#/.test(line) &&
    // A real URL with a real authority. Anchoring on the scheme is what keeps
    // this off `process.stdin`, `source.url` and `registration.enabled`; the
    // `[a-z0-9]` after the slashes is what keeps it off `https://<placeholder>`
    // and `$CP/…`, neither of which names a host.
    /https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(line) &&
    !/nodejs\.org/.test(line);

  /*
   * ⚠ **This asked the wrong question once and had to be narrowed, and the
   * narrowing is the interesting part.** It used to refuse a control-plane host
   * on any line that could *act* on one — an `=`, a `curl`. That was right while
   * the hosted instance was only ever named in prose, and became wrong the day
   * the question turned into a menu: choosing "app.reemoat.com" from a list has
   * to assign it to something. The check went red on correct code.
   *
   * The property was never "the string does not appear in an assignment". It is
   * **"nothing arrives there without being chosen"** — so the assignment is
   * allowed, and what is pinned instead is that it is unreachable except through
   * a menu answer, and that the menu cannot answer it by default.
   */
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
  // Found by the host *name*, not by `namesHost`: a menu option is a label and
  // carries no scheme, which is exactly why it is a label and not a value.
  const menuLine = resolveBody.find((l) => /\bmenu\b/.test(l) && /app\.reemoat\.com/.test(l)) ?? "";
  const optionsAfter = menuLine.slice(menuLine.indexOf("menu "));
  /*
   * **Enter takes the first row**, so the hosted instance being anywhere but
   * first is the whole of the "named as an option, never a default" decision.
   */
  check("the hosted instance is offered, and never first", /"My own"[\s\S]*app\.reemoat\.com/.test(optionsAfter), true);
  // And the assignment happens only on that menu having answered with that row.
  check(
    "and it is assigned only behind that menu's answer",
    /= 2 \]; then\s*$/.test(menuLine.trim()) &&
      namesHost(resolveBody[resolveBody.indexOf(menuLine) + 1] ?? ""),
    true,
  );
  // And the sieve is not simply dropping everything: the one host the script may
  // *fetch* from is still seen, on a line that acts on it.
  check(
    "while the toolchain download still is",
    hosts.some((u) => u.startsWith("https://nodejs.org/")),
    true,
  );
  /*
   * And it *is* named, which is the other half of the decision: somebody who
   * wants the hosted instance should not have to go and find it. A count of zero
   * here would mean the prose quietly lost it and every reader of the prompt is
   * on their own.
   */
  check(
    "and the hosted one is named to the reader, in prose",
    bootstrapLines.some((l) => !/^\s*#/.test(l) && /app\.reemoat\.com/.test(l)),
    true,
  );

  /*
   * **The placeholder is spelled once, and the same way in both files.** The
   * route asserts `split(...).length === 2` at run time; this is the offline half
   * of the same fact, and it reads the constant out of `app.ts` rather than
   * restating it — the "two lists, one fact" shape `.dockerignore` and the
   * Dockerfile already have, except that this one is cheap to check.
   */
  const appSource = readFileSync(join(repoRoot, "packages/control-plane/src/app.ts"), "utf8");
  const placeholder = /^const INSTALL_PLACEHOLDER = "([^"]+)";$/m.exec(appSource)?.[1] ?? "";
  check("app.ts declares the placeholder as a plain literal", placeholder.length > 0, true);
  check(
    "and bootstrap.sh reserves it exactly once",
    bootstrap.split(placeholder).length - 1,
    1,
  );

  /*
   * **Run out of a checkout it refuses rather than guessing**, which is the arm
   * that keeps the paragraph above true: with no substitution and no `--url`
   * there is no control plane, and a script that picked one would pick the
   * author's. Driven for real — `sh bootstrap.sh` with the placeholder still
   * literal — because this is the one branch where being wrong is silent.
   */
  {
    const run = runBootstrap([]);
    check("an unsubstituted script refuses", run.status, 2);
    check("and says how to name a control plane", run.err.includes("--url"), true);
    /*
     * And says only that. `exec 3</dev/tty 2>/dev/null` does **not** silence a
     * failed redirection — the shell reports it itself, outside the redirection
     * that would have caught it — so a host with no controlling terminal printed
     * `line NN: /dev/tty: Device not configured` above the message it was given.
     * Measured on a machine with no tty, and the fix is redirecting the group.
     */
    check("without a shell error above it", /\/dev\/tty/.test(run.err), false);
  }

  /*
   * **A flag with no value says so, and on `dash` that took work.** `shift` and
   * `exec` are POSIX *special builtins*: `shift 2` past `$#` and a failed
   * redirection on `exec` both terminate a non-interactive shell outright, so
   * `shift 2 || die` never reaches its `die` and `{ exec 3</dev/tty; } 2>/dev/null`
   * never reaches its `else`. Measured, `dash` exited with **zero bytes of
   * output** where bash-as-sh printed the intended message — i.e. green on the
   * machine this was written on and silently dead on every Debian host, which is
   * the documented non-interactive path. This runs under whatever `/bin/sh` is,
   * and on `check.yml`'s `ubuntu-latest` that is `dash`.
   */
  for (const flag of ["--url", "--api-key", "--enroll-code", "--label", "--dir", "--ref", "--node", "--agent-source"]) {
    const run = spawnSync("sh", [bootstrapPath, flag], {
      cwd: deployDir,
      encoding: "utf8",
      env: { ...baseEnv, HOME: home },
      input: "",
    });
    check(`${flag} with no value is refused by name`, run.stderr.includes(`${flag} needs a value`), true);
    check("without installing anything on the way", existsSync(join(home, ".reemoat", "toolchain")), false);
  }

  /*
   * **`--agent-source` is the one flag with a closed set of values, and both
   * halves of that are driven (Q4.114).** `parse_flags` runs before anything
   * else in `main`, so a third spelling is refused by name before a terminal is
   * opened or a control plane looked for — and it *has* to be refused there,
   * because the value is written into the daemon's env file for every refresh
   * that follows, and a daemon reads an unknown spelling as `vendor` with one
   * line on stderr nobody installing from `curl | sh` is watching. The accepted
   * spelling is driven too, and what proves it got past the parser is that the
   * run fails *later*, on the placeholder, and says nothing about the flag.
   */
  {
    const bad = runBootstrap(["--agent-source", "bogus"]);
    check("--agent-source with a value it does not know is refused by name", [bad.status, bad.err.includes("--agent-source takes vendor or npm, not bogus")], [2, true]);
    check("without installing anything on the way", existsSync(join(home, ".reemoat", "toolchain")), false);
    const good = runBootstrap(["--agent-source", "npm"]);
    check("while npm passes the parser and fails on the control plane instead", [good.status, good.err.includes("--url"), good.err.includes("--agent-source")], [2, true, false]);
  }

  /*
   * **`REEMOAT_API_KEY` leaves the environment on the line after it is read.** The
   * documented quiet form, `REEMOAT_API_KEY=rk_… sh -c "$(curl …)"`, exports the
   * whole account's key to every child this script starts — `pnpm install`'s
   * lifecycle scripts and the three vendor installers `deploy/agents.sh` downloads
   * and runs — none of which has a use for it. `$API_KEY` is the only reader, so
   * the line after the copy is the `unset`, and no executable line after it
   * expands the name.
   */
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

  /*
   * **`adopt_origin`, through the flag that reaches it first.** Everything below
   * it appends `/v1/…` to what it accepts, so a path lands every request somewhere
   * else, a query or a fragment rides into each one, `user:pass@` puts a
   * credential into the env file, and a scheme that is not http(s) is nothing
   * curl here can speak. Each is exit 2 with the sentence and the value; the
   * control is an origin with a trailing slash, which is stripped and passed on
   * to fail on the network with no such sentence.
   */
  {
    const originRefusal = (url: string): Run => runBootstrap(["--url", url, "--api-key", "rk_x", "--yes"]);
    for (const bad of ["https://cp.example/v1", "https://a:b@cp.example", "https://cp.example?x", "https://cp.example#f", "ftp://cp.example"]) {
      const run = originRefusal(bad);
      // The sentence and the value are checked apart: `die "$2: $1"` puts a
      // colon between them, and the value is the half that tells somebody which
      // of their flags this was.
      check(`${bad} is refused as an origin, naming it`, [run.status, run.err.includes("--url must be an http(s) origin, not"), run.err.includes(bad)], [2, true, true]);
    }
    const control = originRefusal("https://cp.example/");
    check("while an origin with a trailing slash gets past that check", [control.status !== 0, control.err.includes("--url must be an http(s) origin")], [true, false]);
  }

  /*
   * **`credential_body`, with a password the shell and JSON disagree about.** The
   * function alone, extracted and run — never the file sourced — with this
   * process's own node as `NODE_BIN`. The value goes NUL-separated on stdin, so
   * what is asserted is that every character comes back intact through the parse:
   * both quote marks, a backslash, a newline, a `$( … )` that must not run, and a
   * character outside ASCII. `email` is a key only when an address was given.
   */
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

  /*
   * **`main` is called once, on the last line.** That is not style: `curl … | sh`
   * executes bytes as they arrive, so a download cut off half-way runs a prefix
   * of the file — and `set -e` has nothing to say about it, because nothing
   * failed. Everything inside a function makes a truncated file define one and
   * exit. It is a fact about the file's shape rather than about any function in
   * it, which is why it is asserted here rather than driven.
   */
  const nonEmpty = bootstrapLines.filter((line) => line.trim().length > 0);
  check("everything runs from one call on the last line", nonEmpty.at(-1), 'main "$@"');
  // `/^main /` and not `/^main\b/`: the declaration is `main() {`, at column 0,
  // and a word boundary matches it too — which would make this assert "there is
  // a definition and one call" while reading as "one call".
  check(
    "and nothing else calls it",
    bootstrapLines.filter((line) => /^main /.test(line)).length,
    1,
  );

  /*
   * **`sanitize_label` against the control plane's own two regexes**, read out of
   * `machines.ts` rather than retyped: `MACHINE_LABEL` is what the route accepts
   * and `MACHINE_LABEL_RESERVED` is the shape it refuses, and `labelIsWellFormed`
   * is the one call that cannot check one and forget the other. A local copy of
   * either would stay green through the day the server's moved.
   */
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
    /*
     * The function alone, extracted and run — never the file sourced. Sourcing
     * `bootstrap.sh` runs `main "$@"`, which is the whole installer: it would
     * reach the network, and on a substituted copy it would try to add a machine
     * to somebody's fleet. That is not a hypothetical about a future edit; it is
     * what the last line of that file is for.
     */
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
    /*
     * The negative control, without which every line above is a claim about a
     * regex rather than about the function: at least one of those inputs has to
     * be something the route would have refused unsanitised, or `sanitize_label`
     * could be the identity and this section would still be green.
     */
    /*
     * **A name somebody typed is refused, not rewritten**, and refused *before*
     * the first request — under `--yes` there is no prompt to correct it at, and
     * a typo should not cost a round trip. Driven against the same two regexes:
     * anything `MACHINE_LABEL` rejects, or `MACHINE_LABEL_RESERVED` claims, must
     * make the script exit non-zero with a sentence naming the value.
     */
    const labelRefusal = (value: string): { status: number; err: string } =>
      runBootstrap(["--url", "http://127.0.0.1:1", "--api-key", "rk_x", "--yes", "--label", value]);
    for (const bad of ["MacBook Pro.local", "-leading", "m_ab12cd34", "m_0123456789abcdef", "Ünicode"]) {
      check(`${JSON.stringify(bad)} is refused, and by name`, label.test(bad) && !reserved.test(bad), false);
      const out = labelRefusal(bad);
      check(`and the script says so before it asks anything`, [out.status, out.err.includes(bad)], [2, true]);
    }
    // The control: a name the route accepts gets past this check and on to the
    // network, or every line above would pass for a script that refuses all names.
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

  /*
   * **Taking it off again, driven — both halves of `--uninstall` are destructive
   * and neither had a witness.**
   *
   * A fixture per case: a home holding the toolchain and the marker
   * `install_node` writes, a `reemoat.db` standing in for every session's
   * history, a checkout, and optionally the `deploy/lib.sh` the uninstall stops
   * the service *through* and a worktree the purge would take. The stub is what
   * keeps this offline — its `svc_uninstall` prints nothing and succeeds — so
   * what is measured is `do_uninstall`'s own decisions rather than launchd's.
   */
  {
    interface Fixture {
      home: string;
      toolchain: string;
      checkout: string;
      db: string;
    }
    const fixture = (name: string, opts: { lib: boolean; worktree: boolean; env?: boolean }): Fixture => {
      const h = join(sandbox, `uninstall-${name}`);
      rmSync(h, { recursive: true, force: true });
      mkdirSync(join(h, ".reemoat", "toolchain", "bin"), { recursive: true });
      writeFileSync(join(h, ".reemoat", "toolchain", ".installed-by-bootstrap"), "");
      writeFileSync(join(h, ".reemoat", "reemoat.db"), "");
      // The env file `write_env_file` leaves, which is the evidence `do_uninstall`
      // reads for "the install reached the service" when there is no checkout to
      // ask. Present unless a case says otherwise, since every case but one is an
      // install that got that far.
      if (opts.env !== false) writeFileSync(join(h, ".reemoat", "daemon.env"), "REEMOAT_CONTROL_PLANE='https://cp.example'\n");
      mkdirSync(join(h, "co"), { recursive: true });
      if (opts.lib) {
        mkdirSync(join(h, "co", "deploy"), { recursive: true });
        writeFileSync(join(h, "co", "deploy", "lib.sh"), "svc_uninstall() { return 0; }\n");
      }
      if (opts.worktree) mkdirSync(join(h, ".reemoat", "worktrees", "branch-a"), { recursive: true });
      return {
        home: h,
        toolchain: join(h, ".reemoat", "toolchain"),
        checkout: join(h, "co"),
        db: join(h, ".reemoat", "reemoat.db"),
      };
    };
    const uninstall = (f: Fixture, ...args: string[]): Run =>
      runBootstrap(["--dir", f.checkout, "--uninstall", ...args], { HOME: f.home });

    /*
     * ⚠ **The toolchain may not go while the unit is still there.** `hand_off`
     * prefixes it onto PATH, so `runtime_path` bakes its `bin` into the unit's
     * own `@PATH@`; removing it under a unit still on disk leaves launchd's
     * `KeepAlive` — or systemd's `Restart=always` — restarting a wrapper that
     * exits 127 with `node: not found`, every ten seconds, for ever. The way in
     * is an install made with `--dir`, whose checkout this run cannot find, and
     * it used to delete the toolchain anyway and **exit 0** over it, which a
     * provisioning script reads as a clean removal. The env file is what says
     * this install reached the service: `write_env_file` runs before `hand_off`.
     */
    {
      const f = fixture("no-lib", { lib: false, worktree: false });
      const run = uninstall(f);
      check("an uninstall that could not stop the service leaves the toolchain", existsSync(f.toolchain), true);
      check("and does not report success", run.status !== 0, true);
      check("and says which checkout would have worked", run.err.includes(f.checkout), true);
    }
    /*
     * ⚠ **And the install that never reached the service.** `nothing_installed`
     * promises, on every refusal after `ensure_node` — `409 machine_limit` at
     * `create_machine` being the one people meet — that "there is a private node
     * in $TOOLCHAIN, which `--uninstall` removes". That run died before the clone,
     * so there is no checkout and no env file, and the arm above used to read the
     * missing checkout as a service it could not stop: toolchain kept, exit 2,
     * and a sentence asking for `--dir` to a checkout that never existed. No env
     * file is the evidence that no unit was ever rendered, so there is nothing to
     * stop and the promise is kept.
     */
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
    // The control, without which the three above pass for a script that never
    // removes anything: given a lib.sh to stop the service through, it does.
    {
      const f = fixture("with-lib", { lib: true, worktree: false });
      const run = uninstall(f);
      check("while a confirmed stop does remove it", existsSync(f.toolchain), false);
      check("and reports success", run.status, 0);
      check("with the data left alone, because that is what --uninstall promises", existsSync(f.db), true);
    }
    /*
     * ⚠ **`--purge` asks, and the question is not gated on there being
     * worktrees.** It used to sit inside that guard, so a daemon which had never
     * opened a session — no `worktrees/` at all — had `~/.reemoat` and the
     * checkout deleted with nothing printed and nothing asked, on a host with no
     * terminal and no `--yes`. `usage` says "read the list it prints first"; this
     * is what makes that sentence true.
     */
    {
      const f = fixture("purge-empty", { lib: true, worktree: false });
      const run = uninstall(f, "--purge");
      check("--purge with no worktrees still asks", run.status !== 0, true);
      check("and takes nothing when it cannot ask", [existsSync(f.db), existsSync(f.checkout)], [true, true]);
      check("having named what it was about to take", run.err.includes("reemoat.db"), true);
    }
    // And `--yes` is still the way through, because provisioning has no terminal
    // either and this must not become a flag nobody can automate.
    {
      const f = fixture("purge-yes", { lib: true, worktree: false });
      const run = uninstall(f, "--purge", "--yes");
      check("--yes purges", [run.status, existsSync(f.db), existsSync(f.checkout)], [0, false, false]);
    }
    // The working copies, which are the reason the confirmation exists at all: named
    // before the question, and taken only with the answer.
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
  }
}

/* ------------------------------------------------------------------ *
 * svc_uninstall — the verb deploy/ was missing
 * ------------------------------------------------------------------ */

process.stdout.write("\ntaking a service away again\n");

/*
 * Only the refusal is drivable here; the rest boots a supervisor out and belongs
 * with `svc_start` in the header's uncovered list. The refusal is the half worth
 * having offline: the control plane is a container with a named volume holding
 * the key that mints every token in the fleet, and "uninstall" there is
 * `compose.sh down` plus a decision about that volume — not a decision a
 * function called from an installer gets to make.
 */
{
  const refused = sh('svc_uninstall control-plane');
  check("uninstalling a container is refused", refused.status !== 0, true);
  check("and says what to run instead", refused.err.includes("compose.sh down"), true);
  check("naming no unit, because there is none", refused.err.includes("LaunchAgents"), false);
}

process.stdout.write("\nwhat this driver left behind\n");

/*
 * The point of the isolation, asserted rather than assumed. launchd bootstraps
 * every plist in `~/Library/LaunchAgents` at login and the template carries
 * `RunAtLoad`, `KeepAlive` and `ThrottleInterval 10` — so a driver that rendered
 * into a real home would arm a ten-second crash loop at the next reboot, as a
 * side effect of passing.
 */
check("no unit was installed where launchd would find one", existsSync(join(home, "Library/LaunchAgents")), false);
check("nor where systemd would", existsSync(join(home, ".config/systemd/user")), false);
check("and nothing was dropped in the repository", existsSync(join(deployDir, "PWNED")), false);

check("deploy/ is exactly as this run found it", deployState(), deployBefore);

process.stdout.write(failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
