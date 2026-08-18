/**
 * One value of the three lines below, as shell *data* rather than shell source.
 *
 * **`controlPlaneUrl` is caller-influenced and that is why this is not
 * cosmetic.** It is `publicUrl(c)` on the control plane — `new URL(c.req.url).origin`
 * — i.e. it comes from the request's own `Host` header, which anybody who can
 * reach the service writes. Measured 2026-08-08 through a real `node:http`
 * server: a `Host` of ``a`id`b``, `a$(id)b`, `a'b` and `a;id` all reach
 * `URL.origin` intact. Unquoted, the paste then *executes* it — measured,
 * sourcing ``export REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created the
 * file and left the variable reading `http://ab`, so the person pasting sees a
 * plausible URL and nothing else.
 *
 * This is the same rule `deploy/lib.sh`'s `set_env`/`sq` already applies to the
 * env file, after the measured `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident.
 * It was applied to the file and not to the paste, which is the same text
 * arriving by hand into the same shell.
 *
 * Everything inside single quotes is literal to a POSIX shell except a single
 * quote, which is closed, escaped and reopened — the same `'\''` rendering `sq`
 * produces. That arm is **reachable rather than defensive**: an apostrophe
 * survives `URL.origin`, as measured above, so without it the quoting could be
 * closed and stepped out of.
 *
 * The replacement holds no `$`, so `replaceAll`'s `$&`/`` $` `` expansion — the
 * hazard `changes.ts`'s `--no-index` header rewrite records — cannot fire here.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The three lines a daemon is started with.
 *
 * Pure and asserted, because this is text somebody pastes into a shell on another
 * machine and the code inside it is **single-use**: a wrong variable name fails at
 * daemon startup with a message about enrollment rather than about a typo here,
 * and the code is spent either way. Getting it back is another round trip to this
 * screen.
 *
 * `enrollmentLines` in `packages/control-plane/scripts/cpctl.ts` prints the same
 * three lines, quoting included, so the two ways to start a machine agree — and
 * that agreement **is** enforced, by behaviour rather than by a transcription of
 * it. `webcheck` reads `cpctl.ts` off disk, extracts that function's own body,
 * makes it callable and compares its output to this one's over a table of hostile
 * URLs (a backtick, `$(…)`, an apostrophe, a `;`), then asserts by name that
 * cpctl's `BASE_URL` fallback is the **only** difference between the two.
 *
 * What the coupling rests on is worth knowing before renaming anything: the
 * extraction finds `function enrollmentLines(` at the top level of that file and
 * reads to the next bare `}` in column 0. Nest it, rename it, or give it an
 * annotation the extractor does not strip and `webcheck` **throws** rather than
 * quietly skipping the comparison — which is the failure mode to want, and the
 * reason this paragraph says what is enforced instead of assuming somebody will
 * read both files.
 */
export function enrollmentLines(controlPlaneUrl: string, code: string): string {
  return [
    "export REEMOAT_AUTH=signed",
    `export REEMOAT_CONTROL_PLANE=${shellQuote(controlPlaneUrl)}`,
    `export REEMOAT_ENROLL_CODE=${shellQuote(code)}`,
  ].join("\n");
}

/**
 * How long is left, in the shape a person reads rather than a timestamp.
 *
 * A code lives an hour and is single-use, so "expires in 58m" is the fact that
 * decides whether to walk to the other machine now or mint a fresh one later. An
 * ISO string is the same information in a form nobody subtracts in their head.
 */
export function enrollmentExpiryText(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "expires in under a minute";
  if (minutes < 60) return `expires in ${minutes}m`;
  return `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
