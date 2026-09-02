let failures = 0;

export function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(
    `  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`,
  );
}

/**
 * A property that holds, with the measurement beside it.
 *
 * `relaycheck` and `webcheck` both have this and this file did not, so every
 * assertion here that is really about a *bound* — "smaller than", "charged at
 * all" — had to be written as an equality against a number, which then pins the
 * number rather than the property and fails the day somebody legitimately
 * changes a cap. The detail string is what keeps the output readable when the
 * answer is `true`: "34 of 40 refused" says something that `ok` alone does not.
 */
export function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

/**
 * Keep something reachable for the rest of the run.
 *
 * ⚠ **This exists because of the split, and it is the one thing the cut had to
 * add.** One section parks a `PluginHost.install` on a body that never produces
 * a chunk and then walks away from it — deliberately, that client is its whole
 * subject. The install is suspended inside `unpackArchive`'s `for await`,
 * holding the `archive.bin` descriptor it opened, and nothing will ever settle
 * it, so the `finally` that closes the handle never runs.
 *
 * While this was one 22 964-line file that frame stayed reachable from a module
 * body that was still executing, and the descriptor was never collected. Cut
 * into modules, the body finishes, the scope dies, and the next major GC finds a
 * `FileHandle` nobody closed — which Node 26 does not warn about but **kills the
 * process** for, `ERR_INVALID_STATE`, at a different line on every run.
 *
 * So the reachability the old shape gave for free is written down. **The array
 * is a closure variable rather than a module-level `const` on purpose**: nothing
 * reads it, and a top-level binding nothing reads is one V8 elides — measured,
 * the same retainer written that way changed nothing at all. Captured by an
 * exported function it is reachable from the module namespace and stays.
 */
const retained: unknown[] = [];
export function retain(...values: unknown[]): void {
  retained.push(...values);
}

/**
 * The summary line and the exit code.
 *
 * Kept with the counter it reads rather than in the runner, because `failures`
 * is this module's own and nothing outside it may touch it.
 */
export function finish(): void {
  process.stdout.write(
    failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
