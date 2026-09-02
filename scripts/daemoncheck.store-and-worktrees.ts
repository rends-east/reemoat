import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MemoryEventStore,
  oldestAvailable,
  type PersistedSession,
  type SessionEvent,
  type SessionWorkspace,
} from "../src/events.js";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  type FileChange,
} from "../src/changes.js";
import { containedIn } from "../src/paths.js";
import { GitError, hostGit, type GitExec, type GitRun } from "../src/git.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { createApp } from "../src/server.js";
import { SCHEMA_VERSION, openStores } from "../src/store/sqlite.js";
import { createWorkspace, inspectRepo, removeWorkspace, WorktreeError } from "../src/worktree.js";
import { tmp } from "./tmp.js";
import { check } from "./daemoncheck.env.js";
import {
  sandbox,
  users,
  uAbcd,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  credentials,
} from "./daemoncheck.fixtures.js";

/* ------------------------------------------------------------------ *
 * The database, across a restart
 * ------------------------------------------------------------------ */

/**
 * The store the daemon actually runs on, which no driver had ever opened.
 *
 * Every other section here builds a registry from a stub `SessionStore`, so
 * `openStores` had exactly one call site in the repository — `scripts/daemon.ts`
 * — and `migrate()`, the schema-version guard, the widened upsert and the credential
 * store were reached only by starting a real daemon.
 *
 * That matters more than it sounds because `put()`'s failure handler is a bare
 * `catch {}`, deliberately: it runs on the agent's state-change path, where a
 * bookkeeping fault must not unwind a turn. The cost is that a placeholder in the
 * statement that no key of `toParams` answers to would make **every session write
 * fail, silently and permanently**, and the daemon would look perfectly healthy
 * until it restarted with nothing to restore. Only a reopen can see that, so this
 * writes with one bundle and reads with a second.
 */
process.stdout.write("\nthe database, across a restart\n");
{
  const dbPath = join(sandbox, "store", "reemoat.db");
  const old = now - 30 * 24 * 60 * 60 * 1000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const persisted = (id: string, meta: { title?: string | null; pinned?: boolean } = {}) =>
    rowFor(id, join(sandbox, "store-work", id), meta);

  {
    const first = openStores({ path: dbPath, instanceId: "i_writer" });
    first.sessions.put({ ...persisted("s_named"), title: "Fix the reconnect", pinned: true });
    first.sessions.put(persisted("s_plain"));
    first.credentials.save("claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01");
    first.credentials.save("kimi", "KIMI_API_KEY", "kimi-key");
    first.systemCredentials.save("moonshot", "sk-moonshot");
    first.customAgents.save({
      id: "ca_abcd1234",
      name: "Claude Code · K2",
      harness: "claude",
      system: "moonshot",
      model: "kimi-k2-thinking",
      createdAt: now,
    });
    // A session started on it, so the reference survives a restart alongside the
    // preset it names.
    first.sessions.put({ ...persisted("s_routed"), customAgent: "ca_abcd1234" });
    /*
     * ⚠ **Rows naming things this build cannot resolve, written by hand.** They
     * are what a database from a build that knew a fourth harness or a fifth
     * system looks like, and there is no other way to produce one. What is being
     * driven is that they come back as *nothing* rather than as well-typed values
     * `resolveAgent` fails on later, with a worktree already made — Q7.31's
     * precondition, which this work reaches.
     */
    first.db.exec(
      "INSERT INTO custom_agents (id, name, harness, system, model, created_at) " +
        "VALUES ('ca_future1', 'from tomorrow', 'gemini', 'moonshot', 'x', 1), " +
        "('ca_future2', 'also', 'claude', 'bedrock-direct', 'x', 1)",
    );
    first.db.exec("INSERT INTO system_credentials (system, secret, updated_at) VALUES ('gemini', 's', 1)");
    // A row of its own rather than rewriting one of the fixtures above: those
    // are the controls for the title, the pin and the sweep, and a dropped row
    // would make three unrelated assertions fail for a reason none of them names.
    first.sessions.put(persisted("s_future"));
    first.db.exec("UPDATE sessions SET agent = 'gemini' WHERE id = 's_future'");
    first.uploads.insert({
      sessionId: "s_named",
      uploadId: "u_keepme",
      name: "shot.png",
      origName: "Screen Shot.png",
      mime: "image/png",
      bytes: 4096,
      createdAt: now,
      consumedAt: null,
    });
    first.close();
  }

  /*
   * ⚠ **The drops are *reported* now, and for a release they were silent.** Three
   * rows below are unreadable on purpose — a session naming a fourth agent, two
   * presets naming a harness and a system this build lacks, and a key for an
   * unknown system — and `list()` returning one fewer row is not a symptom
   * anybody can act on. The session one is the case with teeth: `restore()` walks
   * `list()`, so a dropped row is never announced and its recorded agent handle
   * never reaches the only `reap` in `src/`, leaving a process alive after the
   * daemon that spawned it died. This file's own convention for exactly this
   * class of fact is `onDegraded`, which the plugin record store already uses.
   */
  const degraded: string[] = [];
  const second = openStores({
    path: dbPath,
    instanceId: "i_reader",
    onDegraded: (detail) => degraded.push(detail),
  });
  const rows = second.sessions.list();
  const aboutFuture = degraded.filter((one) => one.includes("s_future"));
  check(
    "a dropped session says so, with its id and the agent it names",
    // Deduplicated on the *message*, not counted: `openStores` walks the table
    // itself before this driver does, so the same row is reported more than once
    // and the count is an implementation detail. What must hold is that every
    // report names the agent, which is the half an operator acts on.
    [aboutFuture.length > 0, aboutFuture.every((one) => one.includes("gemini"))],
    [true, true],
  );
  check(
    "and says the two things a shorter list cannot",
    degraded.some((one) => one.includes("s_future") && one.includes("reaped")),
    true,
  );
  /*
   * The assertion that catches a swallowed write: the rows are *there at all*.
   *
   * ⚠ **`s_future` is absent and that is the new half.** It was written above and
   * then rewritten to name an agent this build does not have, and `fromRow` drops
   * it rather than casting. The three rows beside it are the positive control — a
   * reader that dropped everything would pass a check written the other way round.
   */
  check("a session written by one daemon is there for the next", rows.map((r) => r.id).sort(), ["s_named", "s_plain", "s_routed"]);
  check(
    "a session naming an agent this build does not have is dropped, not cast",
    rows.some((r) => r.id === "s_future"),
    false,
  );
  check(
    "an assembled agent's reference survives",
    rows.find((r) => r.id === "s_routed")?.customAgent,
    "ca_abcd1234",
  );
  check("and a bare harness records none", rows.find((r) => r.id === "s_named")?.customAgent, null);

  check("a system key written by one daemon is readable by the next", second.systemCredentials.get("moonshot"), "sk-moonshot");
  check("one nobody saved is null", second.systemCredentials.get("anthropic"), null);
  check(
    "a key naming a system this build does not know is not listed",
    second.systemCredentials.list().map((one) => one.system),
    ["moonshot"],
  );
  check(
    "and it is reported rather than only dropped",
    degraded.some((one) => one.includes('system "gemini"')),
    true,
  );
  check(
    "an assembled agent survives whole",
    second.customAgents.get("ca_abcd1234"),
    { id: "ca_abcd1234", name: "Claude Code · K2", harness: "claude", system: "moonshot", model: "kimi-k2-thinking", createdAt: now },
  );
  check(
    "and rows naming a harness or a system this build lacks are dropped from the listing",
    second.customAgents.list().map((one) => one.id),
    ["ca_abcd1234"],
  );
  check("read one at a time, the same", second.customAgents.get("ca_future1"), null);
  check("both halves of that, not just the harness", second.customAgents.get("ca_future2"), null);

  /*
   * ⚠ **The mirror of all three drops above, in a store of its own — because these
   * rows must *survive* and the fixtures above are controls for retention.**
   *
   * This is the asymmetry the whole plugin-contribution feature rests on.
   * Membership is checked where nothing has been created yet — `POST /sessions`,
   * `POST /custom-agents` — so a refusal there costs nothing and no worktree is
   * made. **Shape** is checked here, because everything below runs through
   * `openStores` at boot: before anything is on screen, and *before the plugin host
   * has opened at all*, so "is that plugin installed" is not a question this read
   * can answer. A membership test would therefore delete every session, preset and
   * saved key belonging to a plugin somebody had switched off an hour ago — and
   * switching it back on would not bring them back. What refuses an unrunnable one
   * is `resolveAgent`, at the launch, with a sentence naming the plugin.
   *
   * Driven against the **real** store rather than a `Map`, for the reason the
   * upsert case one block down is: `fromRow` and `readCustomAgent` are the readers
   * under test, and a memory store has neither.
   */
  {
    const path = join(tmp("plugin-rows-"), "d.db");
    const first = openStores({ path, instanceId: "i_plugin_w" });
    first.db.exec(
      "INSERT INTO custom_agents (id, name, harness, system, model, created_at) " +
        "VALUES ('ca_plugin', 'Acme · Llama', 'acme:gemini', 'acme:groq', 'llama-4', 1)",
    );
    first.db.exec("INSERT INTO system_credentials (system, secret, updated_at) VALUES ('acme:groq', 'sk-acme', 1)");
    first.sessions.put(persisted("s_plugin"));
    first.db.exec("UPDATE sessions SET agent = 'acme:gemini' WHERE id = 's_plugin'");
    first.close();

    const dropped: string[] = [];
    const next = openStores({ path, instanceId: "i_plugin_r", onDegraded: (detail) => dropped.push(detail) });
    check(
      "a session on a harness a plugin adds comes back, plugin installed or not",
      next.sessions.list().map((one) => one.agent),
      ["acme:gemini"],
    );
    check(
      "so does a preset built on one, whole",
      next.customAgents.get("ca_plugin"),
      { id: "ca_plugin", name: "Acme · Llama", harness: "acme:gemini", system: "acme:groq", model: "llama-4", createdAt: 1 },
    );
    /*
     * ⚠ **And so does the key — which is what keeps the one control that can
     * delete it on screen.** `prune()` sweeps neither credential table, so a row
     * dropped from this listing is a plaintext secret nothing lists and nothing
     * collects.
     */
    check(
      "and a key saved for a provider one adds",
      [next.systemCredentials.list().map((one) => one.system), next.systemCredentials.get("acme:groq")],
      [["acme:groq"], "sk-acme"],
    );
    check("and none of it was reported as unreadable", dropped, []);
    next.close();
  }

  /*
   * ⚠ **Saving an assembled agent that is already there is an *upsert*, and only
   * the real store can say so.** The route section at the foot of this file stands
   * a `Map` in for `customAgents`, and `Map.set` is an upsert by construction — so
   * `PATCH /custom-agents/:id` satisfies every route assertion there while
   * `SqliteCustomAgentStore.save` remains the bare `INSERT` it was written as, and
   * a real daemon answers the edit `500 internal_error` out of
   * `SQLITE_CONSTRAINT_PRIMARYKEY`. It was a bare insert for as long as a preset
   * was write-once, which is exactly why nothing had ever saved the same id twice.
   *
   * The `createdAt` handed in is deliberately wrong. `created_at` must be absent
   * from the `DO UPDATE SET` list, so that the age of a preset cannot move even
   * when a caller of this port gets it wrong — and the route is such a caller by
   * design, since it reconstructs the whole row rather than patching columns.
   */
  let refusedSecondSave: string | null = null;
  try {
    second.customAgents.save({
      id: "ca_abcd1234",
      name: "Codex · GPT",
      harness: "codex",
      system: "openai",
      model: "gpt-5-codex",
      createdAt: 1,
    });
  } catch (error) {
    // Caught rather than thrown: an uncaught throw here takes every assertion
    // after it down with it, and the message is the answer being looked for.
    refusedSecondSave = error instanceof Error ? error.message : String(error);
  }
  check("saving an assembled agent that is already there does not refuse", refusedSecondSave, null);
  check(
    "it replaces the row rather than adding a second, and the age does not move",
    second.customAgents.list(),
    [{ id: "ca_abcd1234", name: "Codex · GPT", harness: "codex", system: "openai", model: "gpt-5-codex", createdAt: now }],
  );
  const named = rows.find((r) => r.id === "s_named");
  // v5's two columns, and the only ones on this table meant to change after
  // creation — so they are the only ones a `DO UPDATE` clause has to carry.
  check("a title survives the restart", named?.title, "Fix the reconnect");
  check("and so does a pin", named?.pinned, true);
  const plain = rows.find((r) => r.id === "s_plain");
  // `null` and `false`, never `"null"` and `true`: the columns are NULL for every
  // row written before v5, and `String(null)` would name a session "null".
  check("a session written without them reads back unnamed", plain?.title, null);
  check("and unpinned", plain?.pinned, false);

  check("the file is stamped with the version it now matches", Number(second.db.prepare("PRAGMA user_version").get()?.["user_version"]), SCHEMA_VERSION);

  /*
   * The half that decides SQLite over a map, and it is not the transcript half.
   *
   * A `prompt` event carries name/mime/bytes, so an attachment is describable
   * from the log alone — an in-memory registry would pass that test. What it
   * fails is the **accounting**: a restart would reset every session's byte total
   * to zero, and a daemon restart is the ordinary outcome of `deploy.sh`, so one
   * session could write the whole 100 MiB quota again after every one.
   *
   * These two assertions are what fail the day somebody simplifies the index
   * into a `Map`.
   */
  check("a staged upload survives the restart", second.uploads.get("s_named", "u_keepme")?.name, "shot.png");
  /*
   * `consumed_at` round-trips, and this is asserted against the **real** store on
   * purpose.
   *
   * It was hardcoded `NULL` in the insert while `keepAgentImage` set it, so every
   * image an agent returned counted as unconsumed and the 24-hour sweep would
   * have deleted it out from under a transcript still pointing at it. The
   * in-memory `UploadIndex` used elsewhere in this driver honours the field, so
   * the stub passed while the thing that ships did not — which is the whole
   * argument for checking the durable path here rather than only the fake one.
   */
  check("an unconsumed upload reads back unconsumed", second.uploads.get("s_named", "u_keepme")?.consumedAt, null);
  // A session of its own, so this does not perturb the byte-budget assertion
  // two lines up — the counters here are per session and shared fixtures drift.
  second.uploads.insert({
    sessionId: "s_agentimg",
    uploadId: "a_agentimage",
    name: "image-x.png",
    origName: "image-x.png",
    mime: "image/png",
    bytes: 12,
    createdAt: now,
    consumedAt: now,
  });
  check("and a consumed one reads back consumed", second.uploads.get("s_agentimg", "a_agentimage")?.consumedAt, now);
  // The consequence the field exists for: the TTL sweep must not see it.
  check(
    "so the unconsumed sweep never sees it",
    second.uploads.expired(now + 1).map((r) => r.uploadId),
    ["u_keepme"],
  );
  check("and so does what it spends of the session's budget", second.uploads.bytesFor("s_named"), 4096);
  // Keyed on the pair: an id belonging to another session reads as missing rather
  // than as somebody else's file, which is what lets the routes answer without
  // choosing between a 403 and a leak.
  check("but not under another session's id", second.uploads.get("s_plain", "u_keepme"), null);

  // v6 rekeyed this table to (agent, env_name). `envFor` is the one method that
  // hands a secret out, and it is keyed on the agent for that reason: the answer
  // is "what does *this* agent read", never "what is stored".
  check("a credential comes back as its agent's environment", second.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01",
  });
  check("and another agent's is its own", second.credentials.envFor("kimi"), { KIMI_API_KEY: "kimi-key" });
  check("the listing is metadata only", second.credentials.list().map((c) => `${c.agent}:${c.envName}`).sort(), [
    "claude:CLAUDE_CODE_OAUTH_TOKEN",
    "kimi:KIMI_API_KEY",
  ]);
  check("and never the secret itself", JSON.stringify(second.credentials.list()).includes("sk-ant-oat01"), false);
  second.credentials.remove("kimi", "KIMI_API_KEY");
  check("removing one leaves the other", second.credentials.list().map((c) => c.agent), ["claude"]);
  check("and really removes it", second.credentials.envFor("kimi"), {});

  /*
   * **A pin survives the age sweep**, and it did not.
   *
   * `server.ts`'s `listRank` already treats a pin as durable — "a `?limit=` cut
   * that dropped it would make the pin a lie" — and this statement made it a lie by
   * a slower route: the API cut kept a pinned session and the startup prune deleted
   * it, with its whole transcript, at seven days. Two halves of one system
   * disagreeing about what a pin means, and the destructive half was the one that
   * disagreed. The bound is not lost, it moves to the count cap, where pins rank
   * first — so this asserts both directions on rows of exactly the same age.
   */
  second.sessions.put({ ...persisted("s_old_pinned", { pinned: true }), createdAt: old });
  second.sessions.put({ ...persisted("s_old_plain"), createdAt: old });
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  const afterAge = second.sessions.list().map((r) => r.id);
  check("an old unpinned session is swept", afterAge.includes("s_old_plain"), false);
  check("and an old pinned one of the same age is kept", afterAge.includes("s_old_pinned"), true);
  check("while a recent session is untouched either way", afterAge.includes("s_plain"), true);

  /*
   * A pasted credential survives everything `prune()` does, and that is the rule.
   *
   * ⚠ **This section used to assert the opposite, and the reversal is Q7.124.**
   * Both tables had an age-plus-emptiness sweep. It went because `updated_at`
   * moves only on a paste, so the age half was permanently true of any key in
   * real use and the condition collapsed to "no sessions left" — eight idle days,
   * since unpinned sessions age out at seven. What that cost was a machine put
   * down over a holiday coming back with its tokens gone; what it bought was
   * argued away, since deleting a local copy revokes nothing at the vendor and
   * `identity.tunnel_key` sits unswept in the same file regardless.
   *
   * Driven in the state the old sweep was written for and would have fired in —
   * everything aged past every horizon this file has, and not one session left —
   * because an assertion taken with a session still present would pass against
   * the sweep as well and prove nothing.
   */
  second.db.prepare("UPDATE agent_credentials SET updated_at = ?").run(old);
  second.db.prepare("UPDATE system_credentials SET updated_at = ?").run(old);
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  check("an aged credential is kept while any session remains", second.credentials.list().length, 1);
  check("and so is an aged system key", second.systemCredentials.list().length, 1);

  /*
   * Now empty the table of sessions, which was the other half of the old
   * condition and is the state the sweep existed to fire in.
   *
   * ⚠ **A row `fromRow` drops is still a row.** `s_future` names an agent this
   * build does not have, so `list()` does not return it and this loop cannot
   * reach it — while SQL sees it perfectly. That asymmetry mattered while the
   * sweep read `NOT EXISTS (SELECT 1 FROM sessions)`; with no sweep it is only
   * the session count that is affected, and the row is still deliberately kept:
   * deleting one this build cannot read would destroy a session a rollback could,
   * which `compatibility.md` forbids.
   */
  for (const row of second.sessions.list()) second.sessions.remove(row.id);
  second.db.prepare("UPDATE sessions SET created_at = ?").run(old);
  second.db.exec("DELETE FROM sessions");
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  check("with no session left at all, the table is really empty", second.sessions.list(), []);
  /*
   * The four assertions the whole reversal rests on. Proven by putting either
   * `DELETE` back into `prune()` and watching them go red — which is how the
   * sweep they replace was proven in the first place.
   */
  check("a pasted CLI credential outlives every sweep", second.credentials.list().length, 1);
  check("and a system key does too", second.systemCredentials.list().map((one) => one.system), ["moonshot"]);
  check("with the secret still readable", second.systemCredentials.get("moonshot"), "sk-moonshot");
  check(
    "and the only thing that removes one is being asked to",
    (() => {
      second.systemCredentials.remove("moonshot");
      return [second.systemCredentials.list(), second.systemCredentials.get("moonshot")];
    })(),
    [[], null],
  );

  /* ---------------------------------------------------------------- *
   * The agent strip, against a real store
   *
   * ⚠ **The route section stands an array in for this port, and an array cannot
   * show you a transaction.** That is the same blindness recorded at
   * `SqliteCustomAgentStore`'s upsert from the other side — the stand-in there is
   * a `Map`, and `Map.set` is an upsert by construction, so only the real store
   * could report the missing `ON CONFLICT`. Here the two things only a database
   * can be wrong about are that `replace` empties before it refills *atomically*,
   * and that the order survives a file being closed and opened.
   * ---------------------------------------------------------------- */
  {
    const order = [
      { kind: "custom" as const, ref: "ca_11112222", hidden: false },
      { kind: "harness" as const, ref: "kimi", hidden: true },
      { kind: "harness" as const, ref: "claude", hidden: false },
    ];
    second.agentStrip.replace(order);
    check("a strip written to a real file reads back in order", second.agentStrip.list(), order);
    /*
     * ⚠ **`rank` and not insertion order**, which is what the tie-break in `list`
     * is for and what nothing else here could catch: SQLite is free to hand rows
     * back in any order at all without an `ORDER BY`, and on a fresh table
     * insertion order is the one it usually picks — so a missing clause passes
     * every assertion above it and shuffles a strip months later. Written back in
     * reverse, so a store that had forgotten to order would return the *new*
     * insertion order and disagree.
     */
    second.agentStrip.replace([...order].reverse());
    check("and the order it comes back in is the one it was given", second.agentStrip.list().map((one) => one.ref), [
      "claude",
      "kimi",
      "ca_11112222",
    ]);
    second.agentStrip.replace(order);
    check(
      "one position can be forgotten without touching the rest",
      (() => {
        second.agentStrip.forget("harness", "kimi");
        return second.agentStrip.list().map((one) => `${one.kind}:${one.ref}`);
      })(),
      ["custom:ca_11112222", "harness:claude"],
    );
    // Forgetting something that was never there is not an error: the caller is
    // `DELETE /custom-agents/:id`, which runs for a row this build may not be able
    // to resolve and must not start refusing because of it.
    check(
      "and forgetting one that is not there changes nothing",
      (() => {
        second.agentStrip.forget("custom", "ca_never");
        return second.agentStrip.list().length;
      })(),
      2,
    );
    check("an empty replace really empties it", (() => {
      second.agentStrip.replace([]);
      return second.agentStrip.list();
    })(), []);
    /*
     * ⚠ **The hidden flag is a boolean on both sides of an INTEGER column.** It is
     * stored as 1/0 and read back through `!== 0`; a store that handed the number
     * straight out would put `1` where the client's `hidden` is typed `boolean`,
     * which compiles on both sides and is truthy — so every screen would look right
     * and the `PUT` echo would carry a shape the wire says is impossible.
     */
    second.agentStrip.replace([{ kind: "harness", ref: "codex", hidden: true }]);
    check(
      "hidden survives the round trip as a boolean",
      second.agentStrip.list().map((one) => typeof one.hidden + ":" + String(one.hidden)),
      ["boolean:true"],
    );
  }

  second.close();

  /*
   * ⚠ **And it is still there on the next open**, which is the half the two
   * `second.*` blocks above cannot claim: everything up to here happened inside one
   * process holding one handle. The strip is the newest table in this file and the
   * only one created by `schema.sql` alone — no `migrate()` step, no
   * `SCHEMA_VERSION` bump — so "the CREATE TABLE really ran, on a file that already
   * existed" is a claim about this release specifically.
   */
  const third = openStores({ path: dbPath, instanceId: "i_reopen" });
  check("the strip outlives the process that wrote it", third.agentStrip.list(), [
    { kind: "harness", ref: "codex", hidden: true },
  ]);
  third.close();
}

/* ------------------------------------------------------------------ *
 * The v6 migration, which is the only step here that destroys data
 * ------------------------------------------------------------------ */

/*
 * A hand-built v5 file, opened by this daemon, inspected afterwards.
 *
 * What a session changed, against a real repository.
 *
 * `changes.ts` had no driver at all — and `server.ts` carries
 * `maxChangedFiles`/`maxDiffBytes` with the comment "both tunable so the
 * truncation paths can be exercised without 2000 files", seams built for tests
 * nobody wrote. This uses them.
 *
 * A real `git` rather than a stub runner, deliberately. Every rule worth
 * asserting here is a rule about what git actually *prints* — two commands that
 * disagree about field order, an exit status that means success, a header whose
 * replacement string has its own grammar — and a stub would be this driver
 * asserting its own idea of git's output.
 */
process.stdout.write("\nwhat a session changed\n");
{
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  /*
   * `-c` for identity rather than a written config, and `--initial-branch` because
   * a host whose git predates the default-branch flag would otherwise print a
   * hint to stderr and pick something this driver did not choose.
   */
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, "-c", "user.name=daemoncheck", "-c", "user.email=d@example.invalid", ...args], {
      stdio: "pipe",
    });
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { stdio: "pipe" });
  /*
   * **Pinned in the repository's own config, because otherwise this fixture reads
   * the developer's `~/.gitconfig`.** `gitEnv` forwards `HOME` and
   * `XDG_CONFIG_HOME` and `gitArgs` prepends only `-C <dir>`, so every setting a
   * person carries in their global config reaches `hostGit` — and three of them
   * change what the parsers below are handed:
   *
   *   `diff.renames=false`      the rename becomes an add plus a delete, and the
   *                             `2` record this fixture exists to parse never
   *                             appears at all
   *   `diff.noprefix=true`      `--no-index` emits `+++ fresh.txt` with no `b/`,
   *                             so the header-rewrite assertions read a header
   *                             that was never in the shape being asserted
   *   `diff.mnemonicPrefix`     `a/`+`b/` become `i/`+`w/`, same failure
   *
   * Local config outranks global, so four lines here make this driver measure
   * `changes.ts` rather than measuring whoever is running it. Set on the fixture
   * rather than by clearing `HOME`, because the point is to pin the values the
   * parsers were written against, not to have no values.
   */
  git("config", "diff.renames", "true");
  git("config", "status.renames", "true");
  git("config", "diff.noprefix", "false");
  git("config", "diff.mnemonicPrefix", "false");
  writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "moves.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
  writeFileSync(join(repo, "gone.txt"), "delete me\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");

  const info = await inspectRepo(repo, hostGit);
  check("the fixture really is a repository", [info.isRepo, info.insideWorkTree], [true, true]);

  const workspace: SessionWorkspace = {
    mode: "plain",
    root: repo,
    requestedCwd: repo,
    git: {
      repoRoot: info.mainRoot ?? repo,
      commonDir: info.commonDir ?? join(repo, ".git"),
      branch: info.headBranch,
      createdBranch: false,
      baseCommit: info.headCommit ?? "HEAD",
    },
    plainReason: null,
    createdAt: now,
  };

  // One of each shape the parsers have to tell apart.
  writeFileSync(join(repo, "kept.txt"), "one\nTWO CHANGED\nthree\n");
  execFileSync("git", ["-C", repo, "mv", "moves.txt", "moved.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "rm", "--quiet", "gone.txt"], { stdio: "pipe" });
  writeFileSync(join(repo, "fresh.txt"), "brand new\n");
  // The name that broke the header rewrite. `$&` is the whole match in a string
  // replacement, so a path carrying it spliced the absolute path back in.
  writeFileSync(join(repo, "a$&b.txt"), "dollar ampersand\n");
  // An untracked file with a NUL in it, which is git's own binary heuristic and
  // the one answer `--numstat` cannot give: an untracked path has no blob, so it
  // appears in no diff and nothing but reading the bytes can classify it.
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  symlinkSync(join(repo, "kept.txt"), join(repo, "link.txt"));
  // Two links, because git tells us about them differently — see below.
  symlinkSync(join(repo, "kept.txt"), join(repo, "staged-link.txt"));
  execFileSync("git", ["-C", repo, "add", "staged-link.txt"], { stdio: "pipe" });

  const listed = await listChanges(workspace, {
    runner: hostGit,
    base: "session",
    includeIgnored: false,
    limit: DEFAULT_MAX_CHANGED_FILES,
  });
  if (listed.supported) {
    const byPath = new Map(listed.files.map((file) => [file.path, file]));
    check(
      "every kind of change is found, and named by its new path",
      [...byPath.keys()].sort(),
      ["a$&b.txt", "blob.bin", "fresh.txt", "gone.txt", "kept.txt", "link.txt", "moved.txt", "staged-link.txt"],
    );
    check("an edit is modified", byPath.get("kept.txt")?.status, "modified");
    check("a file the agent made is untracked rather than added", byPath.get("fresh.txt")?.status, "untracked");

    /*
     * ⚠ **This answer used to be computed inside the parser, synchronously.**
     * `mergeStatus` called `lstatSync` + `openSync` + `readSync` + `closeSync`
     * once per untracked record, on the event loop, on a tree this daemon did not
     * create — up to the file cap before the cap even applies, and unbounded on a
     * mount that pauses. `stall.ts`'s own docblock cited it as an acceptable
     * exception because these are "paths git has just reported"; git having
     * listed a path says nothing about whether the *next* syscall returns, and
     * for a `plain` session the root is a directory the caller named.
     *
     * It is `markBinary` now — after the cap, through `probeBinary`'s deadline.
     * The behaviour has to be identical, which is what these two assert: new
     * files are the bulk of what an agent produces, and reporting every one of
     * them as text would offer a diff of a PNG.
     */
    check("an untracked file with a NUL in it is binary", byPath.get("blob.bin")?.binary, true);
    check("and an untracked text file is not", byPath.get("fresh.txt")?.binary, false);
    check("a removal is deleted", byPath.get("gone.txt")?.status, "deleted");

    /*
     * The rename, and the reason a shared "read two path tokens" helper would be
     * a bug rather than a simplification: `status --porcelain=v2` emits
     * `<newPath>` then `<origPath>`, while `diff --raw -z` and `--numstat -z`
     * emit `<srcPath>` then `<dstPath>`. `changes.ts` parses both, so one helper
     * would invert every rename in exactly one of them.
     */
    check("a rename is renamed", byPath.get("moved.txt")?.status, "renamed");
    check("naming where it came from, not just where it went", byPath.get("moved.txt")?.oldPath, "moves.txt");
    check("and never the other way round", byPath.get("moves.txt"), undefined);

    /*
     * **The listing knows a symlink only when git tells it the mode**, and git
     * tells it only for a path it is tracking: `symlink` comes off the worktree
     * mode of a porcelain-v2 `1`/`2`/`u` record, and an untracked path is a `?`
     * record with no mode at all. So the flag is a hint on the listing rather
     * than a guarantee — asserted in both directions, because a reader who found
     * only the `true` case would reasonably conclude it can be trusted.
     *
     * Nothing security-relevant rests on it. `diffFile` decides with its own
     * `lstat` on the path, which is what actually stops a link being followed,
     * and that is asserted below for the *untracked* one — the case this flag
     * gets wrong.
     */
    check("a tracked symlink is reported as one, from its mode", byPath.get("staged-link.txt")?.symlink, true);
    check("an untracked one is not, because git sends no mode for it", byPath.get("link.txt")?.symlink, false);
    check("and every path here can be asked about over JSON", listed.files.every((file) => file.addressable), true);
    check("the base is the commit the session started from", listed.base, info.headCommit);
    check("nothing was cut", listed.truncated, null);
  } else {
    check("the change set is supported", listed.supported, true);
  }

  const changeFor = (path: string): FileChange => {
    if (!listed.supported) throw new Error("unreachable: asserted above");
    const found = listed.files.find((file) => file.path === path);
    if (!found) throw new Error(`no change for ${path}`);
    return found;
  };
  const diffOpts = { runner: hostGit, base: "session" as const, contextLines: 3, maxBytes: DEFAULT_MAX_DIFF_BYTES };

  {
    const diff = await diffFile(workspace, changeFor("kept.txt"), diffOpts);
    check("an edit diffs as text", diff.kind, "text");
    check("with the line that changed", diff.patch?.includes("+TWO CHANGED"), true);
    check("and the line it replaced", diff.patch?.includes("-two"), true);
  }

  {
    /*
     * A file git has never seen goes through `diff --no-index`, which **exits 1
     * when the files differ** — that is the success case here, and the path every
     * newly created file takes. Treating it as a failure would make the diff
     * unavailable for exactly the files an agent just wrote.
     */
    const diff = await diffFile(workspace, changeFor("fresh.txt"), diffOpts);
    check("an untracked file still diffs, though git exits 1 saying so", diff.kind, "text");
    check("as all additions", diff.patch?.includes("+brand new"), true);
    /*
     * `--no-index` also names the *absolute* path in its header, which is
     * rewritten to repo-relative so `client diff … | git apply` works.
     */
    check("and the patch names the file the way a patch has to", diff.patch?.includes("+++ b/fresh.txt"), true);
    check("never the absolute path git printed", diff.patch?.includes(repo), false);
  }

  {
    /*
     * The `$&` case, measured: `String.replace(pattern, replacement)` expands
     * `$&`, `` $` ``, `$'` and `$$` in a **string** replacement, and the
     * replacement here is a path the agent chose. `a$&b.txt` rewrote to
     * `--- a/atmp/wt/a$&b.txtb.txt` — the absolute path the rewrite exists to
     * remove, spliced back into the one header that has to be right. A function
     * replacement has no such grammar.
     */
    const diff = await diffFile(workspace, changeFor("a$&b.txt"), diffOpts);
    check("a path with $& in it rewrites to itself", diff.patch?.includes("+++ b/a$&b.txt"), true);
    check("and does not splice the absolute path back in", diff.patch?.includes(repo), false);
  }

  {
    /*
     * ⚠ **git C-quotes a path, and the prefix test did not know it.** A name
     * containing a non-ASCII byte, a `"` or a `\` comes back as
     * `+++ "b/…"` with octal escapes — measured against real git on
     * `réz"me.txt`:
     *
     * ```
     * diff --git "a/r\303\251z\"me.txt" "b/r\303\251z\"me.txt"
     * --- /dev/null
     * +++ "b/<the daemon's absolute path>"
     * ```
     *
     * `startsWith("+++ b/")` matches neither, so that line was left alone while
     * the `diff --git` line above it *was* rewritten (it is replaced outright).
     * The patch came out **self-contradicting** — one header line naming the
     * relative path, the next the absolute one — which is un-appliable, and
     * leaks the daemon's layout in the exact header this rewrite exists to
     * clean. Both path lines are replaced outright now, so quoting cannot
     * matter.
     */
    const odd = 'réz"me.txt';
    writeFileSync(join(repo, odd), "unicode and a quote\n");
    const listed = await listChanges(workspace, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    const change = listed.supported ? listed.files.find((f) => f.path === odd) : undefined;
    check("a C-quoted name still reaches the listing under its real spelling", change !== undefined, true);
    if (change) {
      const diff = await diffFile(workspace, change, diffOpts);
      check("its patch names it the way a patch has to", diff.patch?.includes(`+++ b/${odd}`), true);
      // The half that was broken: the header agreed with itself only because the
      // `diff --git` line is replaced rather than matched.
      check("and the two header lines agree", diff.patch?.includes(`diff --git a/${odd} b/${odd}`), true);
      check("with the absolute path nowhere in it", diff.patch?.includes(repo), false);
    }
  }

  {
    /*
     * Never content-diffed. `git diff --no-index` *follows* the link, so
     * `ln -s ~/.ssh/id_rsa x` would otherwise serve the target's bytes to anyone
     * holding the bearer token. `lstat`, never `stat`.
     */
    const diff = await diffFile(workspace, changeFor("link.txt"), diffOpts);
    check("a symlink is never content-diffed", diff.kind, "symlink");
    check("it reports where it points instead", diff.symlinkTarget, join(repo, "kept.txt"));
    check("and carries no patch at all", diff.patch, null);
    /*
     * **The bytes of the target, checked as bytes.** This line used to read
     * `check(…, diff.patch === null, true)` — the same fact as the line above it,
     * spelled a second way, under a comment promising something stronger. What
     * has to be true is that the *content* of `kept.txt` reaches no field of the
     * answer, not merely that one named field is null, because a regression that
     * followed the link could surface it anywhere. `TWO CHANGED` is the string
     * written into the target at the top of this fixture.
     */
    check("so the target's contents are not served, in any field", JSON.stringify(diff).includes("TWO CHANGED"), false);
  }

  {
    // Both caps, through the seams `server.ts` exposes for exactly this.
    const capped = await listChanges(workspace, { runner: hostGit, base: "session", includeIgnored: false, limit: 2 });
    check("a file cap cuts the list", capped.supported && capped.files.length, 2);
    check("and says so rather than reading as complete", capped.supported && capped.truncated?.reason, "file_limit");
    check("naming the limit it hit", capped.supported && capped.truncated?.limit, 2);

    /*
     * A cut patch is cut **at the last complete line**, so it can never fabricate
     * a final line the file does not have — which is why a cap tight enough that
     * no whole line survives yields nothing rather than half of the `diff --git`
     * header. Both ends of that rule, because only asserting the roomy one would
     * pass for an implementation that simply sliced at the byte.
     */
    const clipped = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 120 });
    check("a byte cap cuts a patch", clipped.truncated, true);
    check("and what is left is shorter than the whole", (clipped.patch?.length ?? 0) < (await diffFile(workspace, changeFor("kept.txt"), diffOpts)).patch!.length, true);
    check("ending on a line break rather than mid-line", clipped.patch?.endsWith("\n"), true);

    const starved = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 16 });
    check("a cap too tight for one whole line carries no patch", starved.patch, null);
    // And it says which kind of nothing, rather than leaving a client to tell an
    // empty patch from a file that genuinely did not change.
    check("reporting itself as empty rather than as a patch of nothing", starved.kind, "empty");
    check("while still admitting it was cut", starved.truncated, true);
  }

  {
    // A directory that is not a repository is a supported answer, not an error —
    // "nothing changed" and "there is nothing to compare against" differ.
    const plain: SessionWorkspace = { ...workspace, git: null };
    const none = await listChanges(plain, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    check("a session outside a repository says so rather than failing", [none.vcs, none.supported], ["none", false]);
    check("with a reason a client can render", none.supported === false && none.reason, "not_a_git_repository");
  }

  /* -- a plain session rooted in a *subdirectory* of a repository --------- */

  {
    /*
     * ⚠ **The two git commands this file parses do not agree about what a path
     * is, and the whole API broke where they disagree.** `git diff` reports
     * **repo-root-relative**; `git status` reports **cwd-relative**
     * (`status.relativePaths` defaults to true). Those are the same string
     * whenever `root` *is* the repo root — every worktree session, and every
     * plain session opened at the top of a repository — which is exactly why
     * nothing caught it.
     *
     * Open a plain session in a subdirectory and one modified file becomes
     * **two rows**: `subdir/kept.txt` carrying the numstat and `kept.txt`
     * carrying the status, each missing half its fields. And both are
     * unaskable — `safeRelPath` resolves against `root`, so the first names a
     * file that is not there and the second never matches the first — which is
     * `GET /sessions/:id/changes/diff` returning `path_not_changed` for
     * everything, permanently, for that shape of session.
     *
     * Driven through real git in that exact shape, because the defect is what
     * the *commands* do rather than what the parsers do — both parsers were
     * correct about the bytes they were handed.
     */
    const nested = join(repo, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "inner.txt"), "one\n");
    // `git(...)`, not a bare `execFileSync`: the helper carries `-c user.name`
    // and `-c user.email`, and a commit without them fails with "Author identity
    // unknown" on any host that has no global git config. A laptop has one and
    // CI does not, which is the whole reason that helper exists.
    git("add", "-A");
    git("commit", "--quiet", "-m", "nested");
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim();
    writeFileSync(join(nested, "inner.txt"), "one\nCHANGED\n");
    writeFileSync(join(nested, "new.txt"), "fresh\n");
    // A file changed *outside* the session's tree, which only this shape can see.
    writeFileSync(join(repo, "kept.txt"), "one\nTWO CHANGED\nthree\nAND AGAIN\n");

    const sub: SessionWorkspace = {
      ...workspace,
      mode: "plain",
      root: nested,
      requestedCwd: nested,
      git: { ...workspace.git!, baseCommit: head },
    };
    const listed = await listChanges(sub, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    const paths = listed.supported ? listed.files.map((f) => f.path).sort() : [];
    check("one changed file is one row, not one per command", paths.filter((p) => p.endsWith("inner.txt")), ["inner.txt"]);
    check("and it is named relative to the session's own root", paths.includes("nested/inner.txt"), false);
    /*
     * Both halves land on that single row, which is the property the duplicate
     * hid: the numstat comes from `diff` and the `xy` from `status`, so a row
     * carrying only one of them is the split reappearing.
     */
    const inner = listed.supported ? listed.files.find((f) => f.path === "inner.txt") : undefined;
    /*
     * The row's existence is its own line, and every assertion below it names
     * `inner !== undefined` rather than reaching through `inner?.`. Optional
     * chaining answers `undefined` for a row that is not there, and
     * `undefined !== null` is *true* — so the three assertions here passed
     * loudest in exactly the case they exist to catch, a listing that produced no
     * `inner.txt` row at all.
     */
    check("the listing has that row at all", inner !== undefined, true);
    check("carrying the numstat that only `diff` knows", inner !== undefined && inner.added !== null && inner.deleted !== null, true);
    check("and the status that only `status` knows", inner !== undefined && inner.xy !== null, true);
    check("an untracked file in the same tree is addressable", listed.supported && listed.files.find((f) => f.path === "new.txt")?.addressable, true);
    /*
     * A file changed outside the tree is still *reported* — the agent touched
     * something and hiding it would be the lie this module is written against —
     * and marked unaskable, because `safeRelPath` refuses a `..` segment and
     * every route that serves bytes would answer `400 invalid_path`.
     */
    const outside = listed.supported ? listed.files.find((f) => f.path.startsWith("../")) : undefined;
    check("a change outside the tree is still shown", outside !== undefined, true);
    check("and marked as one nobody can ask about", outside?.addressable, false);

    /*
     * And the diff route answers, which is the whole point: this returned
     * `path_not_changed` for every path in the listing before, so the feature
     * was not degraded but absent for this shape of session.
     */
    if (inner) {
      const patch = await diffFile(sub, inner, diffOpts);
      check("the diff route answers for a path from that listing", patch.kind, "text");
      check("and its header names the path the caller asked for", patch.patch?.includes("a/inner.txt"), true);
      check("never the repository-relative one", patch.patch?.includes("nested/inner.txt"), false);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Making a worktree under a root that traverses a symlink
 *
 * `containedIn(root, worktreeRoot)` compared a leaf that **cannot exist yet** —
 * a fresh session id — against a root that resolves fully. `resolved()` falls
 * back to the literal string when `realpath` throws, which is right where a path
 * is merely not created yet and wrong when only *one* of the two sides is in
 * that state, which is exactly this call. On any host whose worktree root
 * traverses a symlink the two answers are in different namespaces, the prefix
 * test fails, and **every** session creation is refused with an error accusing
 * the daemon's own configured root of sitting outside itself.
 *
 * It is invisible on an ordinary Linux host and unavoidable on this one: `/tmp`
 * is a symlink to `/private/tmp` on macOS, which is also where every driver in
 * this file puts its sandbox — so the fixture below is the ordinary case rather
 * than a contrived one, and it is built explicitly rather than relying on that,
 * because CI is Linux and would otherwise assert nothing at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nmaking a worktree under a root that is a symlink\n");
{
  const repo = join(sandbox, "wtrepo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=daemoncheck", "-c", "user.email=d@example.invalid", ...args],
      { stdio: "pipe" },
    );
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { stdio: "pipe" });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");

  const realRoot = join(sandbox, "wt-real");
  mkdirSync(realRoot, { recursive: true });
  const linkedRoot = join(sandbox, "wt-link");
  symlinkSync(realRoot, linkedRoot);

  const make = async (sessionId: string, worktreeRoot: string) => {
    try {
      return { made: await createWorkspace({
        cwd: repo,
        sessionId,
        policy: "require",
        worktreeRoot,
        branchPrefix: "dcheck",
        runner: hostGit,
      }), code: null as string | null };
    } catch (error) {
      // Reported as a value rather than rethrown: a regression here refuses
      // *every* session, so it has to fail one line rather than take the rest of
      // this file's coverage down with it.
      return { made: null, code: error instanceof WorktreeError ? error.code : String(error) };
    }
  };

  const first = await make("s_sym", linkedRoot);
  check("a root that traverses a symlink is not outside itself", first.code, null);
  check("and the session really gets a worktree", first.made?.workspace.mode, "worktree");
  check("under the root it was asked for, as written", first.made?.workspace.root.startsWith(`${linkedRoot}/`), true);
  check("on a branch this daemon created", first.made?.workspace.git?.createdBranch, true);
  // The post-add check is untouched by any of this and runs against the tree that
  // now exists, so a creation that reported success really is inside the root.
  check("and it resolves inside the real one too", containedIn(first.made?.workspace.root ?? "", realRoot), true);

  /*
   * The guard that is **not** relaxed, kept as the control.
   *
   * `repoKey` is `<basename>-<sha256(commonDir)[0:8]>`, computable by an agent
   * that has read its own worktree's gitfile — so replacing that one directory
   * with a symlink redirects the *next* session's checkout anywhere this daemon
   * can write, and `existsSync(root)` never catches it because the leaf is a
   * fresh session id. The refusal is by `lstat` on the component rather than by
   * resolving it, because the question is whether this component *is* a link and
   * a resolving check would follow it and answer about the target.
   */
  const repoDir = dirname(first.made?.workspace.root ?? join(linkedRoot, "none"));
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", "--", first.made?.workspace.root ?? ""], {
    stdio: "pipe",
  });
  rmSync(repoDir, { recursive: true, force: true });
  symlinkSync(uAbcd, repoDir);
  const second = await make("s_sym2", linkedRoot);
  check("but a per-repository directory that is a symlink is still refused", second.code, "outside_worktree_root");
}

/* ------------------------------------------------------------------ *
 * Removing one, and the counts that are not zero
 *
 * `count()` and `countStatus` collapse a 5s/15s timeout, a 128 from a stale
 * gitfile, oversized output and an unparseable number into one `null`, and
 * `removeWorkspace` read that with `?? 0`. So "could not tell" became "nothing
 * to lose": a non-forced `DELETE …/workspace?deleteBranch=1` reached `git branch
 * -D` over commits that exist in no other ref and on no remote, and a failed
 * `git status` skipped the dirty refusal standing in front of the one `rmSync`
 * in this codebase. Both are refusals now, and `--force` still overrides both.
 *
 * The runner is scripted rather than real, and that is the point: what has to be
 * driven is git *failing to answer*, which a healthy repository will not do on
 * request. Every case ends by asking the filesystem whether the work is still
 * there, because that — not the return value — is what the defect destroyed.
 * ------------------------------------------------------------------ */

process.stdout.write("\nrefusing to remove a worktree on a count nobody could take\n");
{
  /** git as a script, plus every argv it was handed. */
  const scriptedGit = (answers: {
    status: "empty" | "throw";
    revList: string | "throw";
    remotes?: string;
    removeStderr?: string;
  }): { runner: GitExec; argv: () => string[][] } => {
    const argv: string[][] = [];
    const ok = (stdout: string): GitRun => ({
      stdout: Buffer.from(stdout, "utf8"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const fail = (args: readonly string[], stderr: string): GitError =>
      new GitError("git_failed", args, 128, stderr, `git ${args[0] ?? ""} failed`);

    const run = async (args: readonly string[]): Promise<GitRun> => {
      argv.push([...args]);
      // Unregistered, which `inspectWorkspace` already tolerates by catching —
      // so nothing here has to reproduce `worktree list --porcelain`'s format.
      if (args[0] === "worktree" && args[1] === "list") throw fail(args, "not a working tree");
      if (args[0] === "worktree" && args[1] === "remove") {
        if (answers.removeStderr !== undefined) throw fail(args, answers.removeStderr);
        return ok("");
      }
      if (args[0] === "rev-parse") return ok("c0ffee\n");
      if (args[0] === "rev-list") {
        if (answers.revList === "throw") throw fail(args, "fatal: bad revision");
        return ok(`${answers.revList}\n`);
      }
      if (args[0] === "remote") return ok(answers.remotes ?? "");
      return ok("");
    };
    const readCapped = async (args: readonly string[]): Promise<GitRun> => {
      argv.push([...args]);
      if (args[0] === "status" && answers.status === "throw") throw fail(args, "fatal: not a git repository");
      return ok("");
    };
    return { runner: { run, readCapped }, argv: () => argv };
  };

  const removalRoot = join(sandbox, "removals");
  /** A checkout that really is on disk, holding a file the refusals are about. */
  const worktreeOf = (id: string): SessionWorkspace => {
    const root = join(removalRoot, "repo-abc", id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "work.txt"), "the work nobody could count\n", "utf8");
    return {
      mode: "worktree",
      root,
      requestedCwd: join(sandbox, "wtrepo"),
      git: {
        repoRoot: join(sandbox, "wtrepo"),
        commonDir: join(sandbox, "wtrepo", ".git"),
        branch: `dcheck/${id}`,
        createdBranch: true,
        baseCommit: "c0ffee",
      },
      plainReason: null,
      createdAt: now,
    };
  };
  /** `code:about` per refusal, which is the whole shape a client keys on. */
  const refusalsOf = (result: Awaited<ReturnType<typeof removeWorkspace>>): string[] =>
    result.kind === "refused"
      ? result.refusals.map((refusal) => `${refusal.code}${"about" in refusal ? `:${refusal.about}` : ""}`)
      : [`(${result.kind})`];
  const ran = (argv: string[][], verb: string, sub?: string): boolean =>
    argv.some((args) => args[0] === verb && (sub === undefined || args[1] === sub));

  {
    /*
     * The commit count, which is the one that was irreversible. `rev-list`
     * answers `null` and there are no remotes, so `orphaned` is unknown — and
     * with `?? 0` that is "nothing to lose" one line above `git branch -D`.
     */
    const workspace = worktreeOf("s_rm_commits");
    const git = scriptedGit({ status: "empty", revList: "throw", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: true,
    });
    check("a commit count nobody could take refuses the removal", result.kind, "refused");
    check("saying which count it was", refusalsOf(result), ["counts_unknown:commits"]);
    // The assertion the return value cannot make: the work is still on disk.
    check("the checkout is still there", existsSync(join(workspace.root, "work.txt")), true);
    check("git was never asked to remove it", ran(git.argv(), "worktree", "remove"), false);
    // The irreversible half, and the only copy of those commits.
    check("and the branch was never deleted", ran(git.argv(), "branch"), false);
  }

  {
    /*
     * The dirty count, whose failure was silent in the other direction: `git
     * status` not answering skipped the refusal standing in front of the guarded
     * `rmSync`, so the removal went ahead over changes nobody had been told about.
     * `exists === true` is the precondition — a directory that is genuinely gone
     * has nothing to hold, and refusing there would make the state this path
     * exists to clean up the one state it cannot.
     */
    const workspace = worktreeOf("s_rm_dirty");
    const git = scriptedGit({ status: "throw", revList: "0", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: false,
    });
    check("a dirty count nobody could take refuses too", refusalsOf(result), ["counts_unknown:dirty"]);
    check("and leaves the checkout alone", existsSync(join(workspace.root, "work.txt")), true);
  }

  {
    /*
     * **git refusing is not a partial removal**, and the fall-through treated it
     * as one: the failure was pushed onto `warnings` and execution carried
     * straight on into `rmSync(recursive, force)`, deleting exactly what git had
     * declined to delete — and answering `200 {removed: true}`. So somebody who
     * deliberately did not pass `force` got the forced behaviour with the refusal
     * reduced to a warning nobody has to read.
     *
     * Recognised by git's own words rather than by the call having failed, on the
     * same reasoning as `classifyAddFailure`: every *other* way this can fail is
     * precisely what the guarded rm and the prune exist to clean up.
     */
    const workspace = worktreeOf("s_rm_refused");
    const git = scriptedGit({
      status: "empty",
      revList: "0",
      remotes: "",
      removeStderr: `fatal: '${workspace.root}' contains modified or untracked files, use --force to delete it`,
    });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: false,
    });
    check("git declining is a refusal rather than a warning", refusalsOf(result), ["remove_refused"]);
    check(
      "carrying git's own words, which are the only explanation there is",
      result.kind === "refused" && result.refusals[0]?.code === "remove_refused" && result.refusals[0].stderr.includes("use --force"),
      true,
    );
    // **The one that matters.** Falling through deleted this.
    check("and the work git would not delete is still on disk", existsSync(join(workspace.root, "work.txt")), true);
    // Skipping the prune is safe and deliberate: a worktree git has just declined
    // to remove is still registered and still present, so there is nothing stale.
    check("nothing was pruned on the way past", ran(git.argv(), "worktree", "prune"), false);
  }

  {
    /*
     * The control, without which every assertion above passes for a
     * `removeWorkspace` that refuses everything. Counts that answer, a git that
     * agrees, and the removal happens — including the branch.
     */
    const workspace = worktreeOf("s_rm_ok");
    const git = scriptedGit({ status: "empty", revList: "0", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: true,
    });
    check("a worktree with nothing to lose is removed", result.kind, "removed");
    check("its branch with it, and the prune runs regardless", result.kind === "removed" && [result.branchDeleted, result.pruned], [true, true]);
    check("and the directory really is gone", existsSync(workspace.root), false);
  }

  {
    /*
     * And `--force` still overrides both new refusals, which is what keeps them
     * from being a wall: the remedy `scripts/client.ts` already prints is the
     * remedy that has to work.
     */
    const workspace = worktreeOf("s_rm_forced");
    const git = scriptedGit({ status: "throw", revList: "throw", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: true,
      deleteBranch: true,
    });
    check("force removes a worktree whose counts nobody could take", result.kind, "removed");
    check("passing git the flag rather than deciding for it", git.argv().some((args) => args[0] === "worktree" && args[1] === "remove" && args.includes("--force")), true);
    check("and the directory is gone", existsSync(workspace.root), false);
  }

  /* ---------------------------------------------------------------- *
   * And what the route says about a refusal, which is the only text
   * anybody reads
   *
   * `scripts/client.ts` prints `error.message` and walks nothing else — no
   * caller anywhere reads `detail.refusals` — so the sentence this route picks
   * *is* the answer. It picked one sentence for every refusal, "this worktree
   * still holds work", and `counts_unknown` exists precisely to say the daemon
   * could not tell whether it does. The `?? 0` that was removed from
   * `removeWorkspace` one level down is the same defect: a count nobody could
   * take turned into a claim. Restating it here put it straight back at the
   * boundary — and then invited an operator to force-delete on that evidence,
   * since the CLI's "pass --force" hint hangs off the code beside it.
   *
   * Driven through the real route rather than against the mapping, because the
   * mapping is three lines and the thing that can rot is the route reaching for
   * it.
   * ---------------------------------------------------------------- */

  /**
   * Whichever scripted git the next route call should see.
   *
   * It starts as one that answers everything, so a case which forgets to set its
   * own fails as a `200 {removed: true}` rather than quietly inheriting the
   * previous case's refusals and asserting them twice.
   */
  let routeGit: GitExec = scriptedGit({ status: "empty", revList: "0", remotes: "" }).runner;
  class ScriptedGitRuntime extends LocalRuntime {
    /*
     * Delegating per call rather than handing back `routeGit` itself, and that is
     * not a detail: `createApp` reads `registry.sessionRuntime.git()` **once**,
     * when the app is built, so a runtime returning the current value binds the
     * app to whichever script existed at construction — measured here first, as a
     * `200 {removed: true}` for a case whose whole point is a refusal.
     */
    override git(): GitExec {
      return {
        run: (args, options) => routeGit.run(args, options),
        readCapped: (args, options) => routeGit.readCapped(args, options),
      };
    }
  }

  /*
   * A restored row whose workspace is a worktree. `rowFor` already ends
   * `stopped`, which is the precondition: the route refuses a live session
   * before it ever asks git anything.
   */
  const removalRow = (id: string): PersistedSession => ({
    ...rowFor(id, join(sandbox, "rm-routes", id)),
    workspace: worktreeOf(id),
  });

  const rmRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([removalRow("s_rm_route_unknown"), removalRow("s_rm_route_mixed")]),
    { worktreeRoot: removalRoot, branchPrefix: "dcheck/", defaultMode: "auto" },
    new ScriptedGitRuntime(),
  );
  rmRegistry.restore({ reapOrphans: false });
  const { app: rmApp } = createApp({
    registry: rmRegistry,
    verifier,
    instanceId: "i_rmroutes",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const deleteWorkspace = async (id: string, query: string): Promise<any> => {
    const response = await rmApp.fetch(
      new Request(`http://d/sessions/${id}/workspace?${query}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const body = (await response.json()) as any;
    return {
      status: response.status,
      code: body?.error?.code,
      message: body?.error?.message,
      refusals: (body?.error?.detail?.refusals ?? []).map((refusal: { code: string }) => refusal.code),
    };
  };

  {
    // `rev-list` will not answer and the branch is ours to delete, so the only
    // refusal is the one that means "I could not tell".
    routeGit = scriptedGit({ status: "empty", revList: "throw", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_unknown", "deleteBranch=1");
    check("a refusal nobody could measure is still a 409", refused.status, 409);
    check("but not one that claims there is work here", refused.code, "workspace_uncertain");
    check("and the sentence says which of the two it is", refused.message, "could not tell whether removing this worktree would lose work; force removes it anyway");
    // The remedy travels in the sentence rather than beside it, because the CLI
    // hangs its hint off `workspace_dirty` and a code it has never seen would
    // otherwise take the remedy away along with the lie.
    check("with the remedy in it, which the code no longer carries", refused.message.includes("force"), true);
    check("and the refusals themselves still ride along", refused.refusals, ["counts_unknown"]);
  }

  {
    /*
     * The mixed case, which is what decides the rule rather than restating it: a
     * count nobody could take *and* commits that really are unpushed. The
     * definite refusal wins, because "this worktree still holds work" is then
     * true and is the sentence worth reading.
     */
    routeGit = scriptedGit({ status: "throw", revList: "3", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_mixed", "deleteBranch=1");
    check("a refusal that did measure something says so", [refused.status, refused.code], [409, "workspace_dirty"]);
    check("in the words this arm always used", refused.message, "this worktree still holds work");
    check("with both refusals carried, in the order they were found", refused.refusals, ["counts_unknown", "unpushed_commits"]);
  }
}

/*
 * The transcript on disk, which is the half of the log nothing reached.
 *
 * Every registry case in this file backs its sessions with `MemoryEventStore`,
 * so the store that actually holds somebody's conversation across a restart was
 * never named by a driver. The three rules below are the ones whose failure is
 * *invisible* — a client is handed the wrong events under numbers it already
 * holds, with nothing on the wire to say so — which is exactly the class this
 * subsystem exists to prevent and the class a driver has to catch.
 */
process.stdout.write("\nthe transcript on disk\n");
{
  const evPath = join(sandbox, "events", "reemoat.db");
  const text = (n: number): SessionEvent => ({ type: "text", role: "agent", thought: false, text: `e${n}` });

  {
    const store = openStores({ path: evPath, instanceId: "i_ev" });
    const first = store.events.append("s_ev", text(1));
    store.events.append("s_ev", text(2));
    const third = store.events.append("s_ev", text(3));
    check("seqs are dense from one", [first.seq, third.seq], [1, 3]);
    check(
      "and read back in order",
      store.events.read("s_ev", 0, 100, 1 << 20).map((stored) => (stored.event as { text: string }).text),
      ["e1", "e2", "e3"],
    );
    // `read` is `seq > ?`, which is what makes a cursor a cursor rather than an index.
    check(
      "a cursor is exclusive, so resuming from it repeats nothing",
      store.events.read("s_ev", 2, 100, 1 << 20).map((stored) => stored.seq),
      [3],
    );
    store.sessions.put({ ...rowFor("s_ev", join(users, "u_alice", "ev")), lastSeq: 3, dropped: 0 });
    store.close();
  }

  {
    // The whole point of the store: a different process, the same transcript.
    const store = openStores({ path: evPath, instanceId: "i_ev2" });
    check(
      "another daemon reads what the first one wrote",
      store.events.read("s_ev", 0, 100, 1 << 20).map((stored) => (stored.event as { text: string }).text),
      ["e1", "e2", "e3"],
    );
    check("and carries on numbering rather than starting again", store.events.append("s_ev", text(4)).seq, 4);
    store.close();
  }

  {
    /*
     * Eviction takes a **prefix**, and that is what `dropped = firstSeq - 1`
     * rests on — the counters are rebuilt by deriving them at load rather than
     * persisting them, and deriving is only correct while the surviving rows are
     * contiguous and end at the newest.
     *
     * The numbers are asserted as *relationships* rather than as literals: the
     * slack is clamped to a quarter of the window precisely so a tiny log can be
     * driven, so pinning "exactly six survive" would be pinning the clamp rather
     * than the rule.
     */
    const evictPath = join(sandbox, "evict", "reemoat.db");
    const store = openStores({ path: evictPath, instanceId: "i_evict", maxEventsPerSession: 8 });
    for (let n = 1; n <= 10; n += 1) store.events.append("s_full", text(n));

    const stats = store.events.stats("s_full");
    check("the newest seq is every event ever appended", stats.lastSeq, 10);
    check("something was evicted", stats.count < 10, true);
    check("and everything is accounted for, dropped plus kept", stats.dropped + stats.count, 10);
    /*
     * The two halves of "a strict prefix": what survives starts exactly one past
     * what was dropped, and it runs to the end without a hole.
     */
    check("what survives begins one past what was dropped", stats.firstSeq, stats.dropped + 1);
    const survivors = store.events.read("s_full", 0, 100, 1 << 20);
    check("and runs contiguously to the newest", survivors.map((stored) => stored.seq), [
      ...Array.from({ length: survivors.length }, (_, i) => stats.firstSeq + i),
    ]);
    /*
     * The direction, which is the assertion a "count is bounded" test would pass
     * without: the oldest went and the newest stayed. Evicting the wrong end
     * bounds the log just as well and throws away the conversation somebody is
     * looking at.
     */
    check("the oldest event is gone", (survivors[0]?.event as { text: string }).text !== "e1", true);
    check("and the newest is not", (survivors.at(-1)?.event as { text: string }).text, "e10");
    // Never the last row: `lastSeq = MAX(seq)` has to stay derivable at load.
    check("eviction never takes the newest row", stats.count >= 1, true);
    store.close();
  }

  {
    /*
     * **And by default it never runs at all**, which is the assertion the block
     * above cannot make: it passes an explicit `maxEventsPerSession: 8`, so it
     * pins the mechanism and says nothing about what anybody actually gets.
     *
     * A session's log is not truncated. The old default was 5000 events / 8 MiB
     * evicting a *prefix*, and what that meant was measured rather than reasoned
     * about: a live session on the development machine reached `dropped: 6144`,
     * so its oldest surviving event was an agent `text` chunk containing the two
     * characters `" for"` — a conversation somebody was still working in had lost
     * its beginning, mid-word, permanently.
     *
     * Driven past **both** old defaults rather than at some round number, because
     * those are the two numbers that have to no longer bite — and they are
     * separate `break` conditions in `evict`, so a run that only exceeds the
     * event count leaves the byte bound completely undriven. 6000 events carrying
     * 2 KiB each is past 5000 *and* past 8 MiB; the padding is what makes the
     * second half of that sentence true, and without it this case is 360 KB and
     * asserts nothing about bytes at all.
     */
    const keepPath = join(sandbox, "keep", "reemoat.db");
    const store = openStores({ path: keepPath, instanceId: "i_keep" });
    const padding = "x".repeat(2_048);
    for (let n = 1; n <= 6_000; n += 1) {
      store.events.append("s_keep", { type: "text", role: "agent", thought: false, text: `e${n}${padding}` });
    }

    const stats = store.events.stats("s_keep");
    check("nothing is dropped past the old 5000-event window", stats.dropped, 0);
    check("nor past the old 8 MiB one", stats.approxBytes > 8 * 1024 * 1024, true);
    check("the log still begins at its first event", stats.firstSeq, 1);
    check("with every event still there", stats.count, 6_000);
    // The first event, by content — `firstSeq` alone would survive a store that
    // renumbered, and the thing being defended is the text somebody wrote.
    const first = store.events.read("s_keep", 0, 1, 1 << 20)[0];
    check("and the opening event reads back intact", (first?.event as { text: string }).text, `e1${padding}`);
    store.close();
  }

  {
    /*
     * **The floors, which are the case `firstSeq` alone cannot answer.**
     *
     * A session whose events are gone entirely — pruned, or a disk that rejected
     * every insert — leaves a table that knows nothing about it while the
     * session row still records how far the log got. Without `seedFloors` such a
     * session restarts at seq 1, and a client reconnecting with `since=500` is
     * clamped to 0 and replayed: it receives *different events under numbers it
     * has already seen*, and neither end can detect it.
     */
    const floorPath = join(sandbox, "floors", "reemoat.db");
    {
      const store = openStores({ path: floorPath, instanceId: "i_floor" });
      store.sessions.put({
        ...rowFor("s_pruned", join(users, "u_alice", "pruned")),
        lastSeq: 500,
        dropped: 500,
      });
      store.close();
    }
    const store = openStores({ path: floorPath, instanceId: "i_floor2" });
    const stats = store.events.stats("s_pruned");
    check("a session with no rows left still knows how far it got", stats.lastSeq, 500);
    check("and how much it lost", stats.dropped, 500);
    check("the next event continues the numbering rather than restarting it", store.events.append("s_pruned", text(1)).seq, 501);
    store.close();
  }

  {
    /*
     * `oldestAvailable`, and the measurement that put it in the shared
     * vocabulary rather than in one caller.
     *
     * `firstSeq` is 0 when the table holds no row for a session, so
     * `since < firstSeq - 1` is `since < -1` — false for every cursor, on the one
     * path where *everything* was lost. Measured: stats
     * `{firstSeq: 0, lastSeq: 500, count: 0}` answered a `since=0` attach with
     * `gap: false`, no backlog and `caught_up: 0`, then the next live event at
     * seq 501. Three places have to agree on this — the gap predicate, the
     * `firstSeq` on the wire, and the `firstSeq` on the snapshot — which is why
     * it is a function rather than an expression written out three times.
     */
    check("with rows, the oldest readable seq is the oldest row", oldestAvailable({ firstSeq: 7, lastSeq: 20, count: 14 }), 7);
    check(
      "with none, it is one past the end rather than minus one",
      oldestAvailable({ firstSeq: 0, lastSeq: 500, count: 0 }),
      501,
    );
    check("and an untouched session asks to be served from the start", oldestAvailable({ firstSeq: 0, lastSeq: 0, count: 0 }), 1);
  }

  {
    /*
     * A failed write becomes a placeholder at the **same** seq, never a hole and
     * never the real event.
     *
     * A cycle is the failure SQLite adds that the memory store does not have: it
     * survives `truncateEvent` — `jsonSize` swallows it and reports a few KiB, so
     * nothing is shrunk — and then throws in `JSON.stringify`.
     *
     * Both halves matter. A hole cannot spin the attach loop, because `read` is
     * `seq > ?` — it does something worse, since `lagged` is derived from
     * firstSeq/lastSeq and a hole in the *middle* is invisible on the wire. And
     * the placeholder is what `append` **returns**: handing a live client the
     * real text at a seq while a reconnecting client gets a placeholder there
     * makes the two disagree about what that seq is, undetectably. Both losing it
     * is better than diverging, because the loss is visible.
     */
    const cyclePath = join(sandbox, "cycle", "reemoat.db");
    const store = openStores({ path: cyclePath, instanceId: "i_cycle" });
    store.events.append("s_cycle", text(1));

    const cyclic: Record<string, unknown> = { command: "ls" };
    cyclic["self"] = cyclic;
    const returned = store.events.append("s_cycle", {
      type: "tool_call",
      toolCallId: "t1",
      title: "Terminal",
      kind: "other",
      status: "pending",
      locations: [],
      rawInput: cyclic,
      parentToolCallId: null,
      subagent: false,
    });

    check("the seq is spent rather than skipped", returned.seq, 2);
    check("and what comes back is the placeholder, not the event", returned.event.type, "error");
    store.events.append("s_cycle", text(3));

    const back = store.events.read("s_cycle", 0, 100, 1 << 20);
    check("so the log is contiguous", back.map((stored) => stored.seq), [1, 2, 3]);
    check(
      "and a reader is served exactly what the writer was handed",
      back.map((stored) => stored.event.type),
      ["text", "error", "text"],
    );
    check("with the failure said out loud rather than swallowed", /could not be recorded/.test((back[1]?.event as { message: string }).message), true);
    store.close();
  }

  {
    /*
     * The per-event ceiling is applied *at the store boundary*, which is where
     * retention is owned — `session.ts` passes through what the agent sent and
     * does not decide how much of it is kept. Truncation is visible rather than
     * silent, because a transcript that quietly stops mid-sentence reads as
     * something the agent said.
     */
    const bigPath = join(sandbox, "big", "reemoat.db");
    const store = openStores({ path: bigPath, instanceId: "i_big", maxEventBytes: 2048 });
    const stored = store.events.append("s_big", { type: "text", role: "agent", thought: false, text: "x".repeat(20_000) });
    const kept = (stored.event as { text: string }).text;
    check("an oversized event is clipped rather than refused", kept.length < 20_000, true);
    check("and says so, with this repo's own marker", /\[truncated \d+ bytes\]$/.test(kept), true);
    check("the clipped form is what lands on disk too", (store.events.read("s_big", 0, 10, 1 << 20)[0]?.event as { text: string }).text, kept);
    store.close();
  }
}

/*
 * Everything else in this driver asserts that a thing still works. This asserts
 * that an *upgrade* does not silently take something away — and the two tables it
 * touches are the two that hold secrets, so getting it wrong is unrecoverable
 * rather than inconvenient.
 *
 * Two behaviours, and they are deliberately different:
 *
 *   `agent_credentials` is **rewritten**. A pasted OAuth token is as useful as it
 *   ever was, so losing it would be gratuitous. SQLite cannot drop a primary-key
 *   member, hence create-copy-drop-rename. The copy collapses duplicates — which
 *   only exist in a file written by a multi-tenant daemon — and newest wins.
 *
 *   `forge_accounts` is **dropped**, because of what is in it: plaintext push
 *   tokens that do not expire and that nothing can now revoke, since the routes
 *   that could went with the feature. Leaving the table would leave those secrets
 *   on disk with no code path able to end one, so this is the last moment anybody
 *   can be told — and `migrate()` says so on stderr.
 */
process.stdout.write("\nthe v6 migration\n");
{
  const v5Path = join(sandbox, "v5", "reemoat.db");
  mkdirSync(join(sandbox, "v5"), { recursive: true });

  // The v5 shape, written by hand rather than by an old checkout: what matters is
  // the columns this migration keys on, and inlining them keeps the driver
  // runnable without git archaeology.
  {
    const raw = new DatabaseSync(v5Path);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE agent_credentials (owner_subject TEXT NOT NULL, agent TEXT NOT NULL, " +
        "env_name TEXT NOT NULL, secret TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (owner_subject, agent, env_name))",
    );
    raw.exec(
      "CREATE TABLE forge_accounts (owner_subject TEXT NOT NULL, host TEXT NOT NULL, " +
        "secret TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_subject, host))",
    );
    const ins = raw.prepare(
      "INSERT INTO agent_credentials (owner_subject, agent, env_name, secret, updated_at) VALUES (?,?,?,?,?)",
    );
    // Two owners holding a credential for the *same* (agent, env_name) — the one
    // case where the rewrite has to choose, and the only one that loses a row.
    ins.run("u_old", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-OLD", now - 5_000);
    ins.run("u_new", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-NEWER", now);
    ins.run("u_new", "kimi", "KIMI_API_KEY", "kimi-key", now);
    raw
      .prepare("INSERT INTO forge_accounts (owner_subject, host, secret, updated_at) VALUES (?,?,?,?)")
      .run("u_new", "github.com", "ghp_secret", now);
    raw.exec("PRAGMA user_version = 5");
    raw.close();
  }

  // stderr is captured, because the drop and the collapse are the two places this
  // upgrade destroys something and the only place anybody is told. A count that
  // silently became zero would look identical to a clean migration.
  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  const migrated = openStores({ path: v5Path, instanceId: "i_v6" });
  console.error = realError;
  check("the dropped credential is announced", said.some((line) => line.includes("pasted agent credential")), true);
  // Named, not counted: after the DROP there is no way to learn which forge to go
  // and revoke a token on, so the hosts are read before it.
  check("and the forge drop names the host", said.some((line) => line.includes("github.com")), true);
  const rows = migrated.credentials.list().map((c) => `${c.agent}:${c.envName}`).sort();
  check("both distinct credentials survive the rekey", rows, [
    "claude:CLAUDE_CODE_OAUTH_TOKEN",
    "kimi:KIMI_API_KEY",
  ]);
  // Newest wins, and this is the assertion that would catch the collapse choosing
  // by row order instead: `sk-OLD` is inserted first.
  check("a collision keeps the newer secret", migrated.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-NEWER",
  });

  /*
   * A new *table* needs `schema.sql` and nothing else, and the version must not
   * move for it.
   *
   * `schema.sql` is re-applied on every open and is all `CREATE ... IF NOT
   * EXISTS`, which is idempotent for whole tables and useless for a new column —
   * that asymmetry is why `migrate()` exists. Leaving `SCHEMA_VERSION` alone is
   * the deliberate half: `refuseNewerSchema` throws on a file stamped newer than
   * the running build, so a bump here would turn every rollback into a daemon
   * that will not start, in exchange for nothing.
   */
  migrated.uploads.insert({
    sessionId: "s_x",
    uploadId: "u_x",
    name: "a.txt",
    origName: "a.txt",
    mime: null,
    bytes: 3,
    createdAt: now,
    consumedAt: null,
  });
  check("an upgraded file gains the uploads table", migrated.uploads.get("s_x", "u_x")?.bytes, 3);
  check(
    "and the version does not move for a new table",
    Number(migrated.db.prepare("PRAGMA user_version").get()?.["user_version"]),
    SCHEMA_VERSION,
  );
  check(
    "the owner column is gone from the table",
    migrated.db.prepare("PRAGMA table_info(agent_credentials)").all().map((c) => String(c["name"])),
    ["agent", "env_name", "secret", "updated_at"],
  );
  check(
    "forge_accounts is dropped rather than left holding tokens",
    migrated.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='forge_accounts'")
      .get()?.["n"],
    0,
  );
  check(
    "and the file is stamped with the version it now matches",
    Number(migrated.db.prepare("PRAGMA user_version").get()?.["user_version"]),
    SCHEMA_VERSION,
  );
  migrated.close();

  // Idempotent: the guard is the column's presence, so a second open must not
  // rebuild the table or re-announce a drop that already happened.
  const again = openStores({ path: v5Path, instanceId: "i_v6b" });
  check("a second open changes nothing", again.credentials.list().length, 2);
  again.close();

  /*
   * **Refuse-newer, and that it happens before anything is written.**
   *
   * The SCHEMA_VERSION docblock calls this direction "load-bearing rather than
   * advisory" for v6 and nothing asserted it. It is also an *ordering* property,
   * not just a guard: `openStores` used to run `migrate()` first, so a file from
   * a newer daemon had `agent_credentials` rebuilt and `forge_accounts` dropped
   * before the refusal it was supposed to get. Stamping a table this build would
   * touch and checking it survives is what makes the order observable rather than
   * a matter of reading the two lines in the right sequence.
   */
  /*
   * The tiebreak, which nothing asserted and which a rewrite would silently lose.
   *
   * The collapse orders by `updated_at DESC, owner_subject ASC`. The first key is
   * covered above; the second only decides when two people updated a credential
   * in the same millisecond, so without a fixture that forces a tie a build that
   * dropped it — and became dependent on SQLite's row order — passes everything.
   */
  const tiePath = join(sandbox, "v5-tie", "reemoat.db");
  mkdirSync(join(sandbox, "v5-tie"), { recursive: true });
  {
    const raw = new DatabaseSync(tiePath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE agent_credentials (owner_subject TEXT NOT NULL, agent TEXT NOT NULL, " +
        "env_name TEXT NOT NULL, secret TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (owner_subject, agent, env_name))",
    );
    const ins = raw.prepare(
      "INSERT INTO agent_credentials (owner_subject, agent, env_name, secret, updated_at) VALUES (?,?,?,?,?)",
    );
    // Identical timestamps, inserted with the winner *second*, so row order and
    // the documented rule disagree.
    ins.run("u_zzz", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-LAST-ROW", now);
    ins.run("u_aaa", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-FIRST-OWNER", now);
    raw.exec("PRAGMA user_version = 5");
    raw.close();
  }
  const tied = openStores({ path: tiePath, instanceId: "i_tie" });
  check("a tie is broken by the owner, not by row order", tied.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-FIRST-OWNER",
  });
  tied.close();

  const v7Path = join(sandbox, "v7", "reemoat.db");
  mkdirSync(join(sandbox, "v7"), { recursive: true });
  {
    const raw = new DatabaseSync(v7Path);
    raw.exec("PRAGMA journal_mode = WAL");
    // A table a v6 `migrate()` would drop on sight, so its survival is the proof.
    raw.exec(
      "CREATE TABLE forge_accounts (owner_subject TEXT NOT NULL, host TEXT NOT NULL, " +
        "secret TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_subject, host))",
    );
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
  }
  let refused = false;
  try {
    openStores({ path: v7Path, instanceId: "i_v7" }).close();
  } catch {
    refused = true;
  }
  check("a file from a newer daemon is refused", refused, true);
  {
    const raw = new DatabaseSync(v7Path);
    check(
      "and was refused before this build could migrate it",
      raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='forge_accounts'").get()?.["n"],
      1,
    );
    check(
      "leaving its version untouched",
      Number(raw.prepare("PRAGMA user_version").get()?.["user_version"]),
      SCHEMA_VERSION + 1,
    );
    raw.close();
  }
}
