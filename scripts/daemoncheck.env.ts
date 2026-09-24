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

/** Asserts a property rather than an exact value; `detail` carries the measurement into the output. */
export function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

/** Keeps values reachable for the whole run: a parked plugin install's FileHandle, collected unclosed, kills the process. */
const retained: unknown[] = [];
export function retain(...values: unknown[]): void {
  retained.push(...values);
}

export function finish(): void {
  process.stdout.write(
    failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
