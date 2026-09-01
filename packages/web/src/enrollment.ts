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
 *
 * ⚠ **`shellQuote` above now has a third copy**, in
 * `packages/control-plane/src/app.ts`, where `GET /install.sh` substitutes a
 * caller-influenced origin into a script people pipe into `sh`. It could not
 * import this one — that file is in another package and the image's runtime
 * stage carries no web `src` — so `webcheck` extracts *both* `shellQuote` bodies
 * off disk by the same rule and compares them over the same hostile table. The
 * count in this paragraph is load-bearing: a fourth copy that joins nothing is
 * how the quoting stops agreeing.
 */
export function enrollmentLines(controlPlaneUrl: string, code: string): string {
  return [
    "export REEMOAT_AUTH=signed",
    `export REEMOAT_CONTROL_PLANE=${shellQuote(controlPlaneUrl)}`,
    `export REEMOAT_ENROLL_CODE=${shellQuote(code)}`,
  ].join("\n");
}

/**
 * The one command that takes a machine from nothing to enrolled.
 *
 * `curl -fsSL <origin>/install.sh | sh`, where `<origin>` is **this page's own**
 * — which is the same origin the control plane will see as its `Host` and
 * therefore the same address it substitutes into the script it serves. The page
 * and the server agree by construction rather than by a constant either of them
 * writes down; `packages/web/src/cp.ts` has no base URL at all for the same
 * reason, and says so.
 *
 * A self-hosted instance therefore prints a command pointing at itself, and
 * nothing anywhere in this client names anybody else's control plane.
 *
 * The quoting is **belt rather than braces, and it is applied anyway**.
 * `location.origin` on a same-origin page cannot be chosen by an attacker the
 * way the server's `Host` header can, so the `shellQuote` here is defending
 * against nothing today. It is here because the rule that holds for one of two
 * adjacent values in this file is the rule somebody deletes: `enrollmentLines`
 * one function up quotes for a measured reason, and an unquoted sibling reads as
 * evidence that the measurement was about something else.
 *
 * ⚠ **This is the in-app command, and it is deliberately not the one in the
 * READMEs.** Those point at a release asset on the repository, because a
 * download URL says where the *software* is and must not also decide which
 * fleet a machine joins — see Q4.112. Here there is no such ambiguity: you are
 * signed in to this control plane, looking at its list of machines, and the
 * command means "add one to *this* fleet". `docscheck` pins the README's URL to
 * `SOURCE_URL` and the release asset's name; `webcheck` pins this function. Two
 * strings on purpose, and neither may quietly become the other.
 */
export function installCommand(controlPlaneUrl: string): string {
  // One trailing slash, removed once. `location.origin` never carries one, but
  // this also takes a URL off the wire (`controlPlaneUrl` on a created machine
  // is `publicUrl(c)` server-side), and `https://cp//install.sh` is a 404 with
  // no clue in it.
  const origin = controlPlaneUrl.endsWith("/") ? controlPlaneUrl.slice(0, -1) : controlPlaneUrl;
  return `curl -fsSL ${shellQuote(`${origin}/install.sh`)} | sh`;
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
