/**
 * The driver's own primitives: what it counts, how it says so, and the DOM it
 * stands in for the modules under test.
 *
 * Split out of `webcheck.ts` so the sections can be read one subject at a time.
 * This module is evaluated first — `webcheck.modules.ts` imports it for that
 * reason alone — because the `window` stub below has to be in place before any
 * `packages/web/src` module body runs.
 */

let failures = 0;
let skipped = 0;

export function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

/**
 * Work this run did not do, said as itself.
 *
 * ⚠ **A skip is not a pass, and `report(name, true, "skipped: …")` made it one.**
 * The one caller reads a file out of a *different* repository — the catalogue
 * service's own `catalogue.ts`, four levels above this checkout in the private
 * `reemoat-prod` tree — so on a developer box the mirror is compared and in CI,
 * which checks out this repository alone, it cannot be. That much is deliberate
 * and argued at the call site. What was not deliberate is that the absent case
 * printed `ok` and counted toward the pass tally, so **the assertion CI runs on
 * every push checks no bytes at all** while reading as green. The call site's own
 * docblock names that hazard — "a skip that says nothing is a green tick about
 * work nobody did" — and this is the other half of the fix it describes.
 *
 * Counted rather than only printed, and surfaced in the summary line, so a run
 * that skipped something cannot be mistaken for a run that checked everything.
 * It does **not** fail the driver: the file's absence in CI is the ordinary state
 * and a red build over it would be a driver crying wolf on every push.
 */
export function skip(name: string, detail: string): void {
  skipped += 1;
  process.stdout.write(`  skip  ${name}  (${detail})\n`);
}

export function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        ${detail}\n`);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * A DOM, to the extent these modules need one
 * ------------------------------------------------------------------ */

export const storage = new Map<string, string>();
(globalThis as Record<string, unknown>)["window"] = {
  location: { href: "http://127.0.0.1/", protocol: "http:" },
  localStorage: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => void storage.set(key, value),
    removeItem: (key: string): void => void storage.delete(key),
  },
};

/*
 * A `document`, deliberately **without** `startViewTransition`.
 *
 * `router.ts`'s `announce` reads it to decide whether a navigation can be
 * animated, so a driver that drives `navigate()` needs one — and this stub found
 * that the hard way: closing a sheet became a move that *has* a direction, the
 * short-circuit that had been hiding the read stopped short-circuiting, and a
 * routing check three screens away failed with `document is not defined`.
 *
 * Absent rather than faked, and that is the assertion in disguise: this is an
 * engine that has never heard of view transitions, so every navigation here takes
 * the plain path. What it pins is that the plain path still works — that the
 * animation is an enhancement over a router that routes without it.
 */
(globalThis as Record<string, unknown>)["document"] = {
  documentElement: { dataset: {} as Record<string, string> },
};

/**
 * The summary line and the exit code.
 *
 * Kept with the counters it reads rather than in the runner, because `failures`
 * and `skipped` are this module's own and nothing outside it may touch them.
 */
export function finish(): void {
  // ⚠ **The skip count rides the summary, or the primitive buys nothing.** A run
  // that skipped the cross-repository mirror and a run that compared it print the
  // same "all green" otherwise, which is the state this counter exists to tell
  // apart — see {@link skip}.
  const tail = skipped === 0 ? "" : ` (${skipped} skipped)`;
  process.stdout.write(failures === 0 ? `\nall green${tail}\n\n` : `\n${failures} FAILED${tail}\n\n`);
  process.exit(failures === 0 ? 0 : 1);
}
