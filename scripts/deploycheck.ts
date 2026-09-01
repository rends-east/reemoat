#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const acting = bootstrapLines.filter(
    (line) =>
      !/^\s*#/.test(line) &&
      // A real URL with a real authority. Anchoring on the scheme is what keeps
      // this off `process.stdin`, `source.url` and `registration.enabled`; the
      // `[a-z0-9]` after the slashes is what keeps it off `https://<placeholder>`
      // and `$CP/…`, neither of which names a host.
      /https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(line) &&
      !/nodejs\.org/.test(line) &&
      /(=|\bcurl\b|\bhttp_request\b)/.test(line),
  );
  check("no control-plane host is written into the script as a value", acting, []);
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
    const run = spawnSync("sh", [bootstrapPath], {
      cwd: deployDir,
      encoding: "utf8",
      env: { ...baseEnv, HOME: home },
      // stdin closed, which is also the `curl | sh` shape: it must refuse on the
      // placeholder rather than sit waiting on a prompt it cannot ask.
      input: "",
    });
    check("an unsubstituted script refuses", run.status, 2);
    check("and says how to name a control plane", run.stderr.includes("--url"), true);
    /*
     * And says only that. `exec 3</dev/tty 2>/dev/null` does **not** silence a
     * failed redirection — the shell reports it itself, outside the redirection
     * that would have caught it — so a host with no controlling terminal printed
     * `line NN: /dev/tty: Device not configured` above the message it was given.
     * Measured on a machine with no tty, and the fix is redirecting the group.
     */
    check("without a shell error above it", /\/dev\/tty/.test(run.stderr), false);
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
  for (const flag of ["--url", "--api-key", "--enroll-code", "--label", "--dir", "--ref", "--node"]) {
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
    const labelRefusal = (value: string): { status: number; err: string } => {
      const run = spawnSync(
        "sh",
        [bootstrapPath, "--url", "http://127.0.0.1:1", "--api-key", "rk_x", "--yes", "--label", value],
        { cwd: deployDir, encoding: "utf8", env: { ...baseEnv, HOME: home }, input: "" },
      );
      return { status: run.status ?? -1, err: run.stderr ?? "" };
    };
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
