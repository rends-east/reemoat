import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listDirs, makeDir, PathError, resolveCwd } from "../src/browse.js";
import { atOrUnder, containedIn } from "../src/paths.js";
import { MAX_TITLE_CHARS } from "../src/registry.js";
import { check, report } from "./daemoncheck.env.js";
import { uAb, uAbcd, escape, aFile, tokenFor, app, get } from "./daemoncheck.fixtures.js";

process.stdout.write("\ncontainment\n");

check("a tenant's own subdirectory is inside it", containedIn(join(uAb, "proj"), uAb), true);
check("the root is not strictly inside itself", containedIn(uAb, uAb), false);
check("but it is at-or-under itself", atOrUnder(uAb, uAb), true);
check("u_abcd is NOT inside u_ab  (segment-wise, not startsWith)", containedIn(uAbcd, uAb), false);
check("nor at-or-under it", atOrUnder(uAbcd, uAb), false);
check("a sibling is outside", containedIn(join(uAbcd, "proj"), uAb), false);

check("a symlink out of the root is not inside it", containedIn(escape, uAb), false);
check("nor is anything under it", containedIn(join(escape, "proj"), uAb), false);

process.stdout.write("\nresolveCwd\n");

// The body bound must not wrap uploads: they stream to disk against MAX_UPLOAD_BYTES with their own counter.
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

  // The control: an ordinary body must still pass, or a daemon refusing everything would satisfy the check above.
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
check("so is one somewhere else entirely", await cwdCode(join(uAbcd, "proj")), "(accepted)");
check("so is a path that walks up and back down", await cwdCode(join(uAb, "..", "u_abcd")), "(accepted)");
check("and so is a symlink pointing out of the tree", await cwdCode(escape), "(accepted)");
check("~ means the daemon user's home again", await resolveCwd("~"), realpathSync(homedir()));
// What survives, and all three are answers to "can this be done", not "may it be".
check("a relative path is refused", await cwdCode("proj"), "invalid_path");
check("an empty path is refused", await cwdCode("   "), "invalid_path");
check("a path that is not there is refused", await cwdCode(join(uAb, "nope")), "not_found");
check("and a file is not a directory", await cwdCode(aFile), "not_a_directory");

// A stalled mount cannot be built here, so assert the shape: these return promises, keeping filesystem work off the event loop.
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

}

process.stdout.write("\nan unknown id is 404 on every per-session route\n");
// Both directions per route: a 404 alone passes for a route that 404s for everybody. stream gets a real upgrade below instead.
for (const [name, real, absent] of [
  ["events", "/sessions/s_one/events", "/sessions/s_nope/events"],
  ["changes", "/sessions/s_one/changes", "/sessions/s_nope/changes"],
  [
    "diff",
    "/sessions/s_one/changes/diff?path=notes.txt",
    "/sessions/s_nope/changes/diff?path=notes.txt",
  ],
  ["workspace", "/sessions/s_one/workspace", "/sessions/s_nope/workspace"],
  // files is not here: its positive control answers raw bytes and get parses JSON, so it is covered where a Response is read.
  ["upload download", "/sessions/s_one/uploads/u_x", "/sessions/s_nope/uploads/u_x"],
  ["commands", "/sessions/s_one/commands", "/sessions/s_nope/commands"],
] as const) {
  check(`${name} is 404 for an id that does not exist`, (await get(absent, "u_alice")).status, 404);
  check(`and ${name} answers one that does`, (await get(real, "u_alice")).status !== 404, true);
}

// A restored row has no live agent: commands answers an empty list at revision 0 rather than a refusal, so the composer draws no menu.
check("a session with no live agent has no commands", (await get("/sessions/s_one/commands", "u_alice")).body, {
  revision: 0,
  commands: [],
  dropped: 0,
});

// A POST, so outside the loop; its positive control answers 409 (no live agent), which is not 404.
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

// A limit is safe only because it switches to listRank order, so a cut drops rows nobody is waiting on.
// Must run above the meta block: its pin side effects change what this orders.
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
  // total and truncated are always present, so a client can tell a gone session from one outside the window.
  check("while still reporting how many there really are", cut.body.total, 3);
  check("and saying that it stopped short", cut.body.truncated, true);

  const roomy = await get("/sessions?limit=10", "u_alice");
  check("a limit above the count truncates nothing", roomy.body.truncated, false);
  check("and still returns every row", roomy.body.sessions.length, 3);

  const none = await get("/sessions?limit=0", "u_alice");
  check("zero returns nothing rather than everything", none.body.sessions.length, 0);
  check("and is still honest about the total", [none.body.total, none.body.truncated], [3, true]);

  const negative = await get("/sessions?limit=-5", "u_alice");
  check("a negative limit clamps rather than inverting the cut", negative.body.sessions.length, 0);
  check("and still says the list is not whole", negative.body.truncated, true);

  // A non-numeric limit takes boundedInt's own fallback, a different path from the negative clamp.
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

// A stronger control than config's: setMeta is allowed on a terminal session, so this asserts a real 200 and title.
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
  // null clears and re-arms title derivation from the next prompt; an absent field leaves it alone.
  const cleared = await metaOf("s_one", "u_alice", { title: null });
  check("null clears the title back to unnamed", (await cleared.json() as any).session.title, null);
}

{
  // Compatibility contract: an absent rank reads as a daemon that cannot store order, so it must be null, never omitted.
  const listed = await app.fetch(
    new Request("http://d/sessions", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  const rows = (await listed.json() as any).sessions as { id: string; rank: unknown }[];
  check(
    "a session nobody has positioned reports null rather than omitting the field",
    rows.map((row) => "rank" in row && row.rank === null),
    rows.map(() => true),
  );

  const placed = await metaOf("s_one", "u_alice", { rank: 1_700_000_000_123.5 });
  check("a position lands on the snapshot", (await placed.json() as any).session.rank, 1_700_000_000_123.5);
  const unplaced = await metaOf("s_one", "u_alice", { rank: null });
  check("and null clears it back to following its age", (await unplaced.json() as any).session.rank, null);

  // A non-finite rank breaks the sort: Infinity holds the top for ever, NaN stops the comparator being a total order.
  check("a position that is not a number is refused", (await metaOf("s_one", "u_alice", { rank: "3" })).status, 400);
  // Raw bytes on purpose: JSON.stringify turns Infinity into null, which is the legal clear body.
  const overflow = await app.fetch(
    new Request("http://d/sessions/s_one/meta", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
      body: '{"rank":1e400}',
    }),
  );
  check("and one that is not finite is refused too", overflow.status, 400);
  check("and the refusals changed nothing", (await (await metaOf("s_one", "u_alice", { title: null })).json() as any).session.rank, null);

  // Drop-into-Pinned writes pinned and rank in one request, so it cannot half-apply.
  const both = await metaOf("s_one", "u_alice", { pinned: true, rank: 42 });
  const meta = (await both.json() as any).session;
  check("a pin and a position land in one request", [meta.pinned, meta.rank], [true, 42]);

  // A position is not a listRank tier: resolveDrop re-spaces whole folders, and the prune reads pinned only.
  // s_one is reset first, or two pinned rows fill limit=2 under either rule; equal createdAt ties fall back to input order.
  await metaOf("s_one", "u_alice", { pinned: false, rank: null });
  await metaOf("s_three", "u_alice", { rank: 1_900_000_000_000 });
  const positioned = await get("/sessions?limit=2", "u_alice");
  check(
    "a position does not lift a row past the cut the way a pin does",
    positioned.body.sessions.map((session: { id: string }) => session.id),
    ["s_two", "s_one"],
  );
  await metaOf("s_three", "u_alice", { rank: null });
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
