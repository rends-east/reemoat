import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listDirs, makeDir, PathError, resolveCwd } from "../src/browse.js";
import { atOrUnder, containedIn } from "../src/paths.js";
import { MAX_TITLE_CHARS } from "../src/registry.js";
import { check, report } from "./daemoncheck.env.js";
import { uAb, uAbcd, escape, aFile, tokenFor, app, get } from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * Containment — the primitive everything else rests on
 * ------------------------------------------------------------------ */

process.stdout.write("\ncontainment\n");

check("a tenant's own subdirectory is inside it", containedIn(join(uAb, "proj"), uAb), true);
check("the root is not strictly inside itself", containedIn(uAb, uAb), false);
check("but it is at-or-under itself", atOrUnder(uAb, uAb), true);
check("u_abcd is NOT inside u_ab  (segment-wise, not startsWith)", containedIn(uAbcd, uAb), false);
check("nor at-or-under it", atOrUnder(uAbcd, uAb), false);
check("a sibling is outside", containedIn(join(uAbcd, "proj"), uAb), false);

check("a symlink out of the root is not inside it", containedIn(escape, uAb), false);
check("nor is anything under it", containedIn(join(escape, "proj"), uAb), false);

/* ------------------------------------------------------------------ *
 * resolveCwd — what it still refuses, now that it confines nothing
 * ------------------------------------------------------------------ */

/*
 * This section used to assert the opposite of every line in it, and the
 * inversion is the point rather than an embarrassment: `resolveCwd` was confined
 * to a tenant root, and the reason — a worktree created outside a container's
 * mount — went with the container. What is left is not a weaker boundary, it is
 * not a boundary: the checks below are all about whether the request can be
 * carried out at all.
 */
process.stdout.write("\nresolveCwd\n");

/*
 * ⭐ **The request-body bound, which this daemon had none of.**
 *
 * Every JSON route reads the whole body before it looks at it, on the process
 * that owns the agent subprocesses, the event log and the relay tunnel. The
 * control plane added a bound for this reason and this side had never had one:
 * `REEMOAT_AUTH` answers *who* may ask, which is not an answer to *how much*, and
 * a grant is full access reached from a phone.
 *
 * Both directions are asserted, because the bound has one route it must not
 * reach: uploads stream to disk against `MAX_UPLOAD_BYTES` with their own
 * counter, and wrapping them here would refuse every real upload at a megabyte.
 */
{
  process.stdout.write("\nhow much one request may carry\n");

  const oversized = "x".repeat(2 * 1024 * 1024);
  const fat = await app.fetch(
    new Request("http://d/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_1")}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", cwd: oversized }),
    }),
  );
  check("a body past the bound is refused", fat.status, 413);
  check(
    "in the envelope every client already parses",
    ((await fat.json()) as { error?: { code?: string } }).error?.code,
    "payload_too_large",
  );

  // The guard against a vacuous pass: an ordinary body must still get through,
  // or the assertion above would also hold for a daemon that refuses everything.
  const ordinary = await app.fetch(
    new Request("http://d/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_1")}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", cwd: "/nowhere-in-particular" }),
    }),
  );
  report("while an ordinary one is not", ordinary.status !== 413, `status ${ordinary.status}`);
}

async function cwdCode(input: string): Promise<string> {
  try {
    await resolveCwd(input);
    return "(accepted)";
  } catch (error) {
    return error instanceof PathError ? error.code : "?";
  }
}

check("a directory is accepted", await cwdCode(join(uAb, "proj")), "(accepted)");
// The three that used to be refusals. Somebody keeping a repository in /opt or on
// an external volume is the case this exists to allow.
check("so is one somewhere else entirely", await cwdCode(join(uAbcd, "proj")), "(accepted)");
check("so is a path that walks up and back down", await cwdCode(join(uAb, "..", "u_abcd")), "(accepted)");
check("and so is a symlink pointing out of the tree", await cwdCode(escape), "(accepted)");
check("~ means the daemon user's home again", await resolveCwd("~"), realpathSync(homedir()));
// What survives, and all three are answers to "can this be done", not "may it be".
check("a relative path is refused", await cwdCode("proj"), "invalid_path");
check("an empty path is refused", await cwdCode("   "), "invalid_path");
check("a path that is not there is refused", await cwdCode(join(uAb, "nope")), "not_found");
check("and a file is not a directory", await cwdCode(aFile), "not_a_directory");

/* ------------------------------------------------------------------ *
 * A directory that never answers must not take the daemon with it
 * ------------------------------------------------------------------ */

/*
 * The bug this exists for, measured 2026-08-02 on a real machine.
 *
 * `~/OrbStack` is a hard NFS mount. When its server pauses — the VM sleeping,
 * restarting, or busy — `open()` on it never returns and cannot be interrupted.
 * `browse.ts` did that read **synchronously**, so one directory listing stopped
 * the event loop and the whole daemon died: `/health` accepted the connection and
 * answered nothing, at 0% CPU, until it was killed. The relay tunnel died
 * underneath it without even logging, because the logging needed the same thread.
 *
 * It was reachable only because the browse root became the daemon user's home;
 * while browsing was confined to a small tree there was no stalled mount in it.
 *
 * A stalled mount cannot be built in a driver, so what is asserted is the
 * property that makes one survivable: **these functions are async**, so the
 * filesystem work happens off the event loop. A regression to `readdirSync` would
 * be a type error at every call site, which is the point of asserting the shape
 * rather than the timing.
 */
process.stdout.write("\na stalled directory cannot block the daemon\n");
{
  const listing = listDirs(null, { roots: [uAb], showHidden: false });
  check("listDirs hands back a promise rather than a value", typeof (listing as { then?: unknown }).then, "function");
  check("and it resolves to the roots", (await listing).roots, [uAb]);

  const resolving = resolveCwd(uAb);
  check("resolveCwd is async too", typeof (resolving as { then?: unknown }).then, "function");
  await resolving;

  const making = makeDir(uAb, "async-check");
  check("and so is makeDir", typeof (making as { then?: unknown }).then, "function");
  check("which still creates the folder", (await making).endsWith("async-check"), true);

  /*
   * There was a fourth case here — "a timer can run while a listing is in
   * flight" — and it is **deleted rather than repaired**, because it could not
   * fail. It set a flag from a `setTimeout(…, 0)`, put that timer's promise into
   * a `Promise.all` beside the listing, awaited the pair, and then asserted the
   * flag: the flag is true after that await for a synchronous listing too, since
   * the timer resolves either way. A green line saying nothing is worse than no
   * line, and rewriting it as a real ordering assertion means racing a 1 ms timer
   * against one threadpool round trip — flaky in exactly the direction that
   * teaches a maintainer to ignore this driver. The shape assertions above are
   * what carries the property: `readdirSync` cannot be returned from any of these
   * three without failing the compiler at every call site.
   */
}

process.stdout.write("\nan unknown id is 404 on every per-session route\n");
// Each route is checked in *both* directions, and the positive control is the
// half that carries the weight. A "404 for an unknown id" assertion on its own
// passes for a route that 404s for everybody, which is exactly what happened to
// `stream`: `upgradeWebSocket` falls through on a plain `app.fetch` request, so
// a real id got 404 too and deleting its lookup left the check green. `stream`
// is therefore not tested here at all — it gets a real upgrade below — and the
// rest have to prove they answer an id that exists.
//
// This section used to be about the tenant boundary, and the boundary is gone.
// What it still catches is a route that stops resolving its id at all, which is
// a live way to break every one of them at once.
for (const [name, real, absent] of [
  ["events", "/sessions/s_one/events", "/sessions/s_nope/events"],
  ["changes", "/sessions/s_one/changes", "/sessions/s_nope/changes"],
  [
    "diff",
    "/sessions/s_one/changes/diff?path=notes.txt",
    "/sessions/s_nope/changes/diff?path=notes.txt",
  ],
  ["workspace", "/sessions/s_one/workspace", "/sessions/s_nope/workspace"],
  // `files` is not here: its positive control answers raw bytes, and `get` parses
  // JSON. Both directions are asserted in "serving one file out of a session",
  // where the helper reads a `Response` instead.
  ["upload download", "/sessions/s_one/uploads/u_x", "/sessions/s_nope/uploads/u_x"],
  // The positive control is the half that carries the weight here, exactly as the
  // note above says: a restored row has no live agent, and this route must still
  // answer it with an empty list rather than 404 — otherwise the assertion passes
  // for a route that 404s for everybody.
  ["commands", "/sessions/s_one/commands", "/sessions/s_nope/commands"],
] as const) {
  check(`${name} is 404 for an id that does not exist`, (await get(absent, "u_alice")).status, 404);
  check(`and ${name} answers one that does`, (await get(real, "u_alice")).status !== 404, true);
}

/*
 * And what the commands route *says* about a session with no live agent, which
 * the status alone cannot show.
 *
 * An empty list at revision 0, not a 409. Nothing is asked of the agent here —
 * this reads a field — and "no commands" is the honest answer for a restored row,
 * where a refusal would make the composer draw an error instead of no menu.
 * Revision 0 is also what tells a client there is nothing worth fetching at all.
 */
check("a session with no live agent has no commands", (await get("/sessions/s_one/commands", "u_alice")).body, {
  revision: 0,
  commands: [],
  dropped: 0,
});

// The mode/model/effort route is a POST, so it cannot ride the loop above. Both
// directions, same as the rest: the positive control answers 409
// (`session_not_ready`, since these rows have no live agent), and 409 is
// emphatically not 404.
const configTheirs = await app.fetch(
  new Request("http://d/sessions/s_nope/config", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
    body: JSON.stringify({ modeId: "plan" }),
  }),
);
check("config is 404 for an id that does not exist", configTheirs.status, 404);
const configMine = await app.fetch(
  new Request("http://d/sessions/s_one/config", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
    body: JSON.stringify({ modeId: "plan" }),
  }),
);
check("and config answers one that does", configMine.status !== 404, true);

/* ------------------------------------------------------------------ *
 * Listing sessions, and the reorder a cut depends on
 * ------------------------------------------------------------------ */

/**
 * `?limit=` is safe **only** because the order changes with it.
 *
 * Unbounded, the list is creation order and always has been — `scripts/client.ts`
 * prints it that way. With a limit it is `listRank` order: blocked first, then
 * pinned, then everything still live, then the most recent terminal rows. So
 * dropping the tail can only ever drop rows nobody is waiting on, where cutting
 * creation order could hide the one blocked session the whole product exists to
 * surface.
 *
 * The fixture for this has been staged since the rows were written — `s_two` is
 * pinned *and* second, so a `limit=1` that did not reorder would return `s_one` —
 * and nothing asserted it. This is that assertion.
 *
 * What is deliberately not here is the top of the rank: these rows are restored
 * and terminal, so none of them can hold a pending permission. Blocked-outranks-
 * everything is asserted where a session actually blocks, against a live agent.
 *
 * **This has to run above the `/meta` block, and finding that out is the reason
 * to say so.** Written below it, the cut returned `s_one` — because `setMeta` is
 * exercised there with `{pinned: true}` as the *positive control for renaming a
 * terminal session*, so a second row is pinned as a side effect of an assertion
 * about something else entirely, and two rows sharing a rank and a `createdAt`
 * fall back to insertion order. The registry is module state shared by every
 * section in this file, which is the same hazard `webcheck` writes down beside
 * `sessionGroups`: an assertion about ordering must sit above anything that
 * mutates what it orders.
 */
process.stdout.write("\nlisting sessions, and the cut that reorders\n");
{
  const unbounded = await get("/sessions", "u_alice");
  check(
    "with no limit the list is creation order, as it always was",
    unbounded.body.sessions.map((session: { id: string }) => session.id),
    ["s_one", "s_two", "s_three"],
  );
  check("and says it is whole", [unbounded.body.total, unbounded.body.truncated], [3, false]);

  const cut = await get("/sessions?limit=1", "u_alice");
  check(
    "a cut of one keeps the pinned row, not the first-created one",
    cut.body.sessions.map((session: { id: string }) => session.id),
    ["s_two"],
  );
  /*
   * Both are always present, because a client that prunes state for sessions
   * missing from a response has to tell "gone" from "outside the window" — and a
   * list that quietly stops short reads as complete.
   */
  check("while still reporting how many there really are", cut.body.total, 3);
  check("and saying that it stopped short", cut.body.truncated, true);

  const roomy = await get("/sessions?limit=10", "u_alice");
  check("a limit above the count truncates nothing", roomy.body.truncated, false);
  check("and still returns every row", roomy.body.sessions.length, 3);

  const none = await get("/sessions?limit=0", "u_alice");
  check("zero returns nothing rather than everything", none.body.sessions.length, 0);
  check("and is still honest about the total", [none.body.total, none.body.truncated], [3, true]);

  /*
   * A negative or unparseable limit clamps to zero rather than throwing or
   * wrapping to the whole list, which is the shape that would make a typo in a
   * query string return a hundred megabytes to a phone.
   */
  const negative = await get("/sessions?limit=-5", "u_alice");
  check("a negative limit clamps rather than inverting the cut", negative.body.sessions.length, 0);
  check("and still says the list is not whole", negative.body.truncated, true);

  /*
   * **The unparseable arm, which is a different code path and the one that
   * decides whether a typo returns everything.** `Math.max(0, clampInt(…))`
   * clamps a *number*; a non-numeric string never reaches the `Math.max` at all,
   * it takes `clampInt`'s own fallback. So `limit=-5` says nothing about
   * `limit=abc`, and the comment above claimed both while driving one.
   */
  for (const [name, query] of [
    ["a word", "abc"],
    ["an empty value", ""],
    ["a float", "1.9"],
    ["something enormous", "1e9"],
  ] as const) {
    const odd = await get(`/sessions?limit=${query}`, "u_alice");
    check(
      `${name} never returns more than the list holds`,
      odd.body.sessions.length <= 3 && odd.body.total === 3,
      true,
    );
  }
}

// Renaming is a POST too, and its positive control is stronger than `/config`'s:
// `setMeta` is deliberately allowed on a terminal session, so this asserts a real
// 200 and a real returned title rather than settling for "not 404". A route that
// 404s for everybody would pass the negative half alone — which is exactly how
// `stream` stayed green with its lookup deleted.
const metaOf = async (id: string, sub: string, body: unknown) =>
  app.fetch(
    new Request(`http://d/sessions/${id}/meta`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(sub)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
check("meta is 404 for an id that does not exist", (await metaOf("s_nope", "u_alice", { title: "x" })).status, 404);
{
  const renamed = await metaOf("s_one", "u_alice", { title: "  Fix the\treconnect  " });
  check("and meta answers one that does", renamed.status, 200);
  // Normalized on the way in, and answered with the snapshot rather than an echo,
  // so a client never has to guess what was actually stored.
  check("with the normalized title, not the raw one", (await renamed.json() as any).session.title, "Fix the reconnect");
}
check(
  "renaming a session that has ended is allowed, not refused",
  (await metaOf("s_one", "u_alice", { pinned: true })).status,
  200,
);
check(
  "an over-long title is refused rather than silently clipped",
  (await metaOf("s_one", "u_alice", { title: "x".repeat(MAX_TITLE_CHARS + 1) })).status,
  400,
);
check("and an empty body is refused too", (await metaOf("s_one", "u_alice", {})).status, 400);
{
  // `null` clears, which is what re-arms derivation from the next prompt. It has
  // to be distinguishable from "field absent", which means leave it alone.
  const cleared = await metaOf("s_one", "u_alice", { title: null });
  check("null clears the title back to unnamed", (await cleared.json() as any).session.title, null);
}

// A DELETE with `machine:admin` still cannot invent a session. The scope widens
// what may be done to a row, never which rows exist.
const adminDelete = await app.fetch(
  new Request("http://d/sessions/s_nope/workspace", {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
  }),
);
check("machine:admin cannot reach an id that does not exist", adminDelete.status, 404);
