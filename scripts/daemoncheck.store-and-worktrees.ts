import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MemoryEventStore,
  oldestAvailable,
  type ExitReason,
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
import type { BackgroundTask } from "../src/acp/asynctasks.js";
import { containedIn } from "../src/paths.js";
import { GitError, hostGit, type GitExec, type GitRun } from "../src/git.js";
import { SessionRegistry } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { createApp } from "../src/server.js";
import { DEFAULT_MIN_SESSIONS, SCHEMA_VERSION, openStores, takeDaemonRow } from "../src/store/sqlite.js";
import type { DaemonRow } from "../src/store/sqlite.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateStaticKey, localStaticKey } from "@reemoat/protocol";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { MACHINE_KEY_HEADER } from "../src/relay/protocol.js";
import { ensureMachineKey, machineKeyRotation } from "../src/machinekey.js";
import { jwkThumbprint, x25519Jwk } from "../src/token.js";
import { createWorkspace, inspectRepo, removeWorkspace, WorktreeError } from "../src/worktree.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
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

/** The real store through a reopen: put swallows its own failures, so a broken statement fails every write silently and only a reopen shows it. */
process.stdout.write("\nthe database, across a restart\n");

const keptTask: BackgroundTask = {
  id: "t",
  name: "npm test",
  taskType: "shell",
  description: "runs the suite",
  state: "completed",
  summary: "passed",
  lastToolName: null,
  usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
  canStop: true,
  showInTranscript: false,
  outputFilePath: "/tmp/x/tasks/t.output",
  toolCallId: "toolu_1",
  startedAt: 1_000,
  endedAt: 2_000,
};

const badState: [string, string][] = [
  ["notobject", "[]"],
  ["nullconfig", '{"config":null,"commands":{"commands":[],"dropped":0}}'],
  ["nullcommands", '{"config":{"modes":null,"options":[]},"commands":null}'],
  ["optionsnotarray", '{"config":{"modes":null,"options":{}},"commands":{"commands":[],"dropped":0}}'],
  ["listnotarray", '{"config":{"modes":null,"options":[]},"commands":{"commands":{},"dropped":0}}'],
  ["modesnoavailable", '{"config":{"modes":{"current":"plan"},"options":[]},"commands":{"commands":[],"dropped":0}}'],
  ["modesnotobject", '{"config":{"modes":3,"options":[]},"commands":{"commands":[],"dropped":0}}'],
  ["optionnull", '{"config":{"modes":null,"options":[null]},"commands":{"commands":[],"dropped":0}}'],
  ["optionnochoices", '{"config":{"modes":null,"options":[{"id":"model","kind":"select","value":"opus"}]},"commands":{"commands":[],"dropped":0}}'],
  ["choicenotobject", '{"config":{"modes":null,"options":[{"id":"model","kind":"select","value":"opus","choices":[7]}]},"commands":{"commands":[],"dropped":0}}'],
  ["commandnoname", '{"config":{"modes":null,"options":[]},"commands":{"commands":[{}],"dropped":0}}'],
];

{
  const dbPath = join(sandbox, "store", "reemoat.db");
  const old = now - 30 * 24 * 60 * 60 * 1000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const persisted = (id: string, meta: { title?: string | null; pinned?: boolean; rank?: number | null } = {}) =>
    rowFor(id, join(sandbox, "store-work", id), meta);

  {
    const first = openStores({ path: dbPath, instanceId: "i_writer" });
    first.sessions.put({ ...persisted("s_named"), title: "Fix the reconnect", pinned: true, rank: 1_700_000_000_123.5 });
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
    first.sessions.put({ ...persisted("s_routed"), customAgent: "ca_abcd1234" });
    // Rows naming a harness and a system this build cannot resolve, written by hand: they must come back as nothing, not values resolveAgent fails on later (Q7.31).
    first.db.exec(
      "INSERT INTO custom_agents (id, name, harness, system, model, created_at) " +
        "VALUES ('ca_future1', 'from tomorrow', 'gemini', 'moonshot', 'x', 1), " +
        "('ca_future2', 'also', 'claude', 'bedrock-direct', 'x', 1)",
    );
    first.db.exec("INSERT INTO system_credentials (system, secret, updated_at) VALUES ('gemini', 's', 1)");
    // An unreadable blob comes back null without taking the session with it (fromRow's own catch drops the whole row).
    first.sessions.put({
      ...persisted("s_remembered"),
      agentState: {
        config: {
          modes: { current: "plan", available: [{ id: "plan", name: "Plan", description: null }] },
          options: [
            {
              id: "model",
              name: "Model",
              description: null,
              category: "model",
              kind: "select",
              value: "opus",
              choices: [{ value: "opus", name: "Opus", description: "the selected one keeps its prose", group: null }],
            },
          ],
        },
        commands: { commands: [{ name: "context", description: "Show current context usage", hint: null }], dropped: 0 },
        // Hand-written like the rest: a live row is one no restart can honour, so it is dropped and its neighbour kept (Q2.234).
        tasks: [
          { ...keptTask, id: "t_done" },
          { ...keptTask, id: "t_live", state: "running", endedAt: null },
        ],
      },
    });
    first.sessions.put(persisted("s_tasks_unreadable"));
    first.db.exec(
      `UPDATE sessions SET agent_state_json = '{"config":{"modes":null,"options":[]},"commands":{"commands":[{"name":"context","description":"","hint":null}],"dropped":0},"tasks":5}' WHERE id = 's_tasks_unreadable'`,
    );
    first.sessions.put(persisted("s_unreadable"));
    first.db.exec("UPDATE sessions SET agent_state_json = '{not json' WHERE id = 's_unreadable'");
    // Blobs that parse with wrong elements: adopted, they throw inside snapshot and break GET /sessions, so each is forgotten while its session comes back.
    for (const [name, blob] of badState) {
      first.sessions.put(persisted(`s_bad_${name}`));
      first.db.exec(`UPDATE sessions SET agent_state_json = '${blob}' WHERE id = 's_bad_${name}'`);
    }
    // modes absent entirely must survive as null: JSON.stringify omits an undefined key (compatibility.md rule 2).
    first.sessions.put(persisted("s_nomodes"));
    first.db.exec(
      `UPDATE sessions SET agent_state_json = '{"config":{"options":[]},"commands":{"commands":[{"name":"context","description":"","hint":null}],"dropped":0}}' WHERE id = 's_nomodes'`,
    );

    // A row of its own: the fixtures above are the controls for the title, the pin and the sweep.
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

  // Drops are reported through onDegraded: a dropped session's agent handle never reaches reap, so a shorter list is not enough.
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
    // Deduplicated on the message, not counted: openStores walks the table itself first, so a row is reported more than once.
    [aboutFuture.length > 0, aboutFuture.every((one) => one.includes("gemini"))],
    [true, true],
  );
  check(
    "and says the two things a shorter list cannot",
    degraded.some((one) => one.includes("s_future") && one.includes("reaped")),
    true,
  );
  // Catches a swallowed write: every row written above is back, except s_future, which fromRow drops rather than casts.
  check(
    "a session written by one daemon is there for the next",
    rows.map((r) => r.id).sort(),
    [
      ...badState.map(([name]) => `s_bad_${name}`),
      "s_named",
      "s_nomodes",
      "s_plain",
      "s_remembered",
      "s_routed",
      "s_tasks_unreadable",
      "s_unreadable",
    ].sort(),
  );
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

  // Plugin rows must survive: shape is checked at boot, before the plugin host opens, so a membership test would delete a switched-off plugin's rows.
  // Against the real store, since fromRow and readCustomAgent are the readers under test.
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
    // prune sweeps neither credential table, so a key dropped from this listing is a secret nothing lists or collects.
    check(
      "and a key saved for a provider one adds",
      [next.systemCredentials.list().map((one) => one.system), next.systemCredentials.get("acme:groq")],
      [["acme:groq"], "sk-acme"],
    );
    check("and none of it was reported as unreadable", dropped, []);
    next.close();
  }

  // Only the real store shows a second save upserts (the route section's Map always does).
  // The createdAt passed is deliberately wrong: created_at must stay out of the update so a preset's age never moves.
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
    refusedSecondSave = error instanceof Error ? error.message : String(error);
  }
  check("saving an assembled agent that is already there does not refuse", refusedSecondSave, null);
  check(
    "it replaces the row rather than adding a second, and the age does not move",
    second.customAgents.list(),
    [{ id: "ca_abcd1234", name: "Codex · GPT", harness: "codex", system: "openai", model: "gpt-5-codex", createdAt: now }],
  );
  const named = rows.find((r) => r.id === "s_named");
  check("a title survives the restart", named?.title, "Fix the reconnect");
  check("and so does a pin", named?.pinned, true);
  {
    const remembered = rows.find((row) => row.id === "s_remembered");
    check("the agent's controls survive the restart", remembered?.agentState?.config.options[0]?.value, "opus");
    check("and the mode with them", remembered?.agentState?.config.modes?.current, "plan");
    check("and the command list, which is what the `/` menu is", remembered?.agentState?.commands.commands[0]?.name, "context");
    check("and the finished background rows, a live one dropped alone", remembered?.agentState?.tasks, [{ ...keptTask, id: "t_done" }]);
    const tasksUnreadable = rows.find((row) => row.id === "s_tasks_unreadable");
    check(
      "a task list this build cannot read costs the tasks, never the controls beside them",
      [tasksUnreadable?.agentState?.commands.commands[0]?.name, tasksUnreadable?.agentState?.tasks],
      ["context", undefined],
    );
    const unreadable = rows.find((row) => row.id === "s_unreadable");
    // Not a sentinel fallback: the value under test is null, so the row's presence is asserted separately.
    check("a blob this build cannot read is forgotten", unreadable?.agentState, null);
    check("and the session it belongs to is not", unreadable?.id, "s_unreadable");
    // Both halves per row: a guard that threw would pass the first and lose the session to fromRow's catch.
    const kept = badState.map(([name]) => rows.find((row) => row.id === `s_bad_${name}`));
    check(
      "a blob that parses but is not the declared shape is forgotten, every kind of it",
      kept.map((row) => row?.agentState ?? "<forgotten>"),
      badState.map(() => "<forgotten>"),
    );
    check(
      "and not one of them cost its session",
      kept.map((row) => row?.id ?? "<lost>"),
      badState.map(([name]) => `s_bad_${name}`),
    );
    const noModes = rows.find((row) => row.id === "s_nomodes");
    check("a blob with no modes at all degrades to null rather than being dropped", noModes?.agentState?.config.modes, null);
    check("keeping everything beside it", noModes?.agentState?.commands.commands[0]?.name, "context");
  }
  // rank is REAL: a drop between adjacent milliseconds must land strictly between them, and INTEGER would round to a tie.
  check("and so does a position, fraction included", named?.rank, 1_700_000_000_123.5);
  const plain = rows.find((r) => r.id === "s_plain");
  // `null` and `false`, never `"null"` and `true`: the columns are NULL for every
  // row written before v5, and `String(null)` would name a session "null".
  check("a session written without them reads back unnamed", plain?.title, null);
  // null, never 0: Number of null is 0, the oldest position, which would sink every row that predates the column.
  check("and one nobody positioned follows its age rather than leading the list", plain?.rank, null);
  check("and unpinned", plain?.pinned, false);

  check("the file is stamped with the version it now matches", Number(second.db.prepare("PRAGMA user_version").get()?.["user_version"]), SCHEMA_VERSION);

  // Why SQLite over a Map: the byte accounting must survive a restart, or a session could spend its quota again after every deploy.
  check("a staged upload survives the restart", second.uploads.get("s_named", "u_keepme")?.name, "shot.png");
  // consumed_at round-trips against the real store: the in-memory UploadIndex honours it even where the shipped insert did not.
  check("an unconsumed upload reads back unconsumed", second.uploads.get("s_named", "u_keepme")?.consumedAt, null);
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
  check(
    "so the unconsumed sweep never sees it",
    second.uploads.expired(now + 1).map((r) => r.uploadId),
    ["u_keepme"],
  );
  check("and so does what it spends of the session's budget", second.uploads.bytesFor("s_named"), 4096);
  // Keyed on the pair: another session's id reads as missing, so the routes need not choose between a 403 and a leak.
  check("but not under another session's id", second.uploads.get("s_plain", "u_keepme"), null);

  // envFor is the one method that hands a secret out, keyed on the agent: what this agent reads, never what is stored.
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

  // Pins rank first and survive the inactivity sweep; both rows are inactive and aged by updated_at (Q2.222), with minSessions 0 so the floor keeps neither.
  second.sessions.put({ ...persisted("s_old_pinned", { pinned: true }), createdAt: old });
  second.sessions.put({ ...persisted("s_old_plain"), createdAt: old });
  second.db.prepare("UPDATE sessions SET updated_at = ? WHERE id IN ('s_old_pinned', 's_old_plain')").run(old);
  second.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 });
  const afterAge = second.sessions.list().map((r) => r.id);
  check("an old unpinned session is swept", afterAge.includes("s_old_plain"), false);
  check("and an old pinned one of the same age is kept", afterAge.includes("s_old_pinned"), true);
  check("while a recent session is untouched either way", afterAge.includes("s_plain"), true);

  // A pasted credential survives everything prune does (Q7.124), with every row aged and then with no session left.
  second.db.prepare("UPDATE agent_credentials SET updated_at = ?").run(old);
  second.db.prepare("UPDATE system_credentials SET updated_at = ?").run(old);
  second.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 });
  check("an aged credential is kept while any session remains", second.credentials.list().length, 1);
  check("and so is an aged system key", second.systemCredentials.list().length, 1);

  // s_future is invisible to list but still a row, so the table is emptied in SQL.
  for (const row of second.sessions.list()) second.sessions.remove(row.id);
  second.db.prepare("UPDATE sessions SET created_at = ?, updated_at = ?").run(old, old);
  second.db.exec("DELETE FROM sessions");
  second.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 });
  check("with no session left at all, the table is really empty", second.sessions.list(), []);
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

  // The startup prune's three rules (Q2.222), each driven alone on its own database and onPruned collector.
  // put stamps updated_at with the clock, so both dates are set behind it.
  {
    const reports: string[] = [];
    const own = openStores({
      path: join(sandbox, "store", "prune.db"),
      instanceId: "i_pruner",
      onPruned: (detail) => reports.push(detail),
    });
    const template = persisted("s_prune_template");
    const DAY = 24 * 60 * 60 * 1000;
    const eightDaysAgo = now - 8 * DAY;
    const minuteAgo = now - 60 * 1000;
    // gaveUp true writes the one value resume_gave_up holds; a string is written verbatim to fake a build that persists another.
    const row = (id: string, exit: ExitReason | "live", meta: { pinned?: boolean; gaveUp?: boolean | string } = {}): PersistedSession => ({
      ...template,
      id,
      pinned: meta.pinned ?? false,
      resumeGaveUp: meta.gaveUp === true ? "forgotten" : typeof meta.gaveUp === "string" ? meta.gaveUp : null,
      status: exit === "live" ? "idle" : "exited",
      exit: exit === "live" ? null : { reason: exit, at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
    });
    const seed = (session: PersistedSession, at: { created: number; updated: number }): void => {
      own.sessions.put(session);
      own.db
        .prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
        .run(at.created, at.updated, session.id);
    };
    // Off the table rather than `list()`, which drops a row it cannot parse —
    // and one of the rows below is unreadable on purpose.
    const ids = (): string[] => own.db.prepare("SELECT id FROM sessions ORDER BY id").all().map((r) => String(r["id"]));
    // Through `remove()` so the store's own last-written cache forgets the id;
    // a bare `DELETE` would leave `put` treating the next identical row as unchanged.
    const reset = (): void => {
      for (const id of ids()) own.sessions.remove(id);
      reports.length = 0;
    };
    // OR REPLACE, so that a store which failed to sweep the first orphan is named
    // by the second half's pin rather than by a UNIQUE-constraint throw here.
    const orphan = (): number => {
      own.db.prepare("INSERT OR REPLACE INTO events (session_id, seq, ts, bytes, payload) VALUES ('s_nobody', 1, ?, 2, '{}')").run(now);
      return Number(own.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's_nobody'").get()?.["n"]);
    };
    const orphansLeft = (): number =>
      Number(own.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 's_nobody'").get()?.["n"]);

    reset();
    for (let i = 0; i < 5; i += 1) {
      seed(row(`s_inc_${i}`, "daemon_shutdown"), { created: eightDaysAgo, updated: minuteAgo });
    }
    seed(row("s_inc_survivor", "daemon_shutdown"), { created: now - 4 * DAY, updated: minuteAgo });
    const incident = ids();
    own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 });
    check("the incident: six rows just stopped by SIGTERM, five of them opened eight days ago — none is pruned", ids(), incident);
    own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 });
    check("and none with the floor in place either", ids(), incident);
    check("and nothing is reported, because nothing was pruned", reports, []);

    // Rule 1 alone, under a floor of zero: every ExitReason (the Record is exhaustive, so a new reason must pick a side).
    // Plus the rows the exit or resume_gave_up alone would misread: given up is inactive, but a live row or an unknown value is kept.
    reset();
    const stale = { created: eightDaysAgo, updated: eightDaysAgo };
    const byReason: Record<ExitReason, "swept" | "kept"> = {
      stopped: "swept",
      agent_exited: "swept",
      agent_signed_out: "swept",
      start_failed: "swept",
      start_timeout: "swept",
      agent_kill_failed: "swept",
      daemon_shutdown: "kept",
      daemon_restarted: "kept",
      config_changed: "kept",
      // parked keeps its conversation but is not in DAEMON_EXIT_REASONS, so isActiveRow must not read that list; this line is the only net (Q2.222).
      parked: "kept",
    };
    const reasons = Object.keys(byReason) as ExitReason[];
    for (const reason of reasons) seed(row(`s_b_${reason}`, reason), stale);
    seed(row("s_b_live", "live"), stale);
    seed(row("s_b_pinned", "stopped", { pinned: true }), stale);
    seed(row("s_b_unreadable", "stopped"), stale);
    own.db.prepare("UPDATE sessions SET exit_json = 'not json' WHERE id = 's_b_unreadable'").run();
    seed(row("s_b_unknown", "stopped"), stale);
    own.db.prepare(`UPDATE sessions SET exit_json = '{"reason":"daemon_upgraded"}' WHERE id = 's_b_unknown'`).run();
    seed(row("s_b_active", "stopped"), { created: eightDaysAgo, updated: minuteAgo });
    seed(row("s_b_gave_up", "daemon_shutdown", { gaveUp: true }), stale);
    seed(row("s_b_live_gave_up", "live", { gaveUp: true }), stale);
    seed(row("s_b_gave_up_unknown", "daemon_shutdown", { gaveUp: "daemon_upgraded" }), stale);
    const removedByAge = own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 }).sort();
    const left = ids();
    for (const reason of reasons) {
      check(`a ${reason} row untouched for eight days is ${byReason[reason]}`, left.includes(`s_b_${reason}`), byReason[reason] === "kept");
    }
    check("a live row is never swept by age", left.includes("s_b_live"), true);
    check("a pinned row is kept", left.includes("s_b_pinned"), true);
    check("a row whose exit cannot be read is kept", left.includes("s_b_unreadable"), true);
    check("and one whose exit names a reason this build cannot", left.includes("s_b_unknown"), true);
    check("a row opened eight days ago and written a minute ago is kept: activity, not creation", left.includes("s_b_active"), true);
    check(
      "a daemon_shutdown row eight days idle that the daemon has given up on is swept: given up is inactive whatever the exit says",
      left.includes("s_b_gave_up"),
      false,
    );
    check("while its twin, with resume_gave_up NULL, is kept", left.includes("s_b_daemon_shutdown"), true);
    check("a live row carrying resume_gave_up is kept: live is read first, and the next boot comes back to it", left.includes("s_b_live_gave_up"), true);
    check(
      "and a daemon_shutdown row whose resume_gave_up this build cannot name is kept, as an exit it cannot read is",
      left.includes("s_b_gave_up_unknown"),
      true,
    );
    check(
      "and the seven swept are the whole of what was returned",
      removedByAge,
      [...reasons.filter((reason) => byReason[reason] === "swept").map((reason) => `s_b_${reason}`), "s_b_gave_up"].sort(),
    );

    // Rule 2: the floor is on what is left, not a gate on the count; an orphan event is swept regardless (Q2.222).
    reset();
    const pad = (i: number): string => String(i).padStart(2, "0");
    for (let i = 0; i < 49; i += 1) {
      seed(row(`s_floor_${pad(i)}`, "stopped"), { created: eightDaysAgo, updated: eightDaysAgo + i * 1000 });
    }
    check("an event belonging to no session is there to be swept", orphan(), 1);
    own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 });
    check("forty-nine stale rows under a floor of fifty: nothing is removed", ids().length, 49);
    check("while the orphan event is swept regardless", orphansLeft(), 0);
    check("and nothing is reported under the floor", reports, []);
    seed(row("s_floor_49", "live"), { created: now, updated: now });
    check("a second orphan, for the other half", orphan(), 1);
    own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 });
    check("the fiftieth row lets nothing go: fifty rows are the floor, kept whatever their age", ids().length, 50);
    check("and the orphan still goes", orphansLeft(), 0);
    for (let i = 0; i < 10; i += 1) {
      seed(row(`s_floor_x${i}`, "stopped"), { created: eightDaysAgo, updated: eightDaysAgo + (100 + i) * 1000 });
    }
    const pastFloor = own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 }).sort();
    check(
      "sixty rows under a floor of fifty: the ten least recently touched stale ones go",
      pastFloor,
      Array.from({ length: 10 }, (_, i) => `s_floor_${pad(i)}`),
    );
    check("and fifty are left — the live row and the forty-nine most recently touched", [ids().length, ids().includes("s_floor_49")], [50, true]);

    // The floor outranks the cap, whatever either is set to.
    reset();
    for (let i = 0; i < 60; i += 1) seed(row(`s_fc_${pad(i)}`, "stopped"), { created: now, updated: minuteAgo + i * 1000 });
    const underFloor = own.sessions.prune({ retainMs: week, maxSessions: 30, minSessions: 50 }).sort();
    check("a cap under the floor cuts only past the floor: ten of sixty, not thirty", underFloor, Array.from({ length: 10 }, (_, i) => `s_fc_${pad(i)}`));
    check("and the table is left at the floor, not the cap", ids().length, 50);
    reset();
    for (let i = 0; i < 300; i += 1) seed(row(`s_fx_${String(i).padStart(3, "0")}`, "stopped"), { created: now, updated: minuteAgo + i * 1000 });
    check("and a floor above the cap leaves the cap nothing to cut", own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 300 }), []);

    // Rule 3: rows are updated oldest-first but created newest-first, so a cap still ranking by creation cuts 203-207 instead of 4-8 (Q2.222).
    // The eight untouchable rows are touched least recently of all, so a cap that ranked them would cut them first.
    reset();
    for (let i = 0; i < 208; i += 1) {
      const id = `s_cap_${String(i).padStart(3, "0")}`;
      const exit = i >= 1 && i <= 3 ? "daemon_shutdown" : "stopped";
      seed(row(id, exit, { pinned: i === 0 }), { created: now - i * 1000, updated: eightDaysAgo + i * 1000 });
    }
    const untouchable: Array<[string, string | null]> = [
      ["s_cap_live", null],
      ["s_cap_not_json", "not json"],
      ["s_cap_unknown", '{"reason":"daemon_upgraded"}'],
      ["s_cap_json_null", "null"],
      ["s_cap_json_string", '"daemon_shutdown"'],
      ["s_cap_json_array", "[]"],
      ["s_cap_no_reason", "{}"],
      ["s_cap_null_reason", '{"reason":null}'],
    ];
    for (const [id, exitJson] of untouchable) {
      seed(row(id, "live"), { created: now, updated: eightDaysAgo - 1000 });
      if (exitJson !== null) own.db.prepare("UPDATE sessions SET exit_json = ? WHERE id = ?").run(exitJson, id);
    }
    const overCap = own.sessions.prune({ retainMs: 1000 * 365 * DAY, maxSessions: 200, minSessions: 0 }).sort();
    check("two hundred and five rows nobody is coming back to, under a cap of two hundred: exactly five go", overCap.length, 5);
    check(
      "the five least recently *updated* inactive rows — not the pin, not the three interrupted ones, and not the five oldest by creation",
      overCap,
      ["s_cap_004", "s_cap_005", "s_cap_006", "s_cap_007", "s_cap_008"],
    );
    check("and the table ends above the cap by exactly its active rows", ids().length, 200 + 3 + untouchable.length);
    check(
      "the eight rows the cap may not touch, every one touched less recently than anything it cut, are all still there",
      untouchable.map(([id]) => id).filter((id) => !ids().includes(id)),
      [],
    );

    // Active rows alone over the cap lose nothing; among pins the least recently touched goes, and an unpinned inactive row before any pin (Q2.222).
    reset();
    for (let i = 0; i < 150; i += 1) seed(row(`s_int_${String(i).padStart(3, "0")}`, "daemon_shutdown"), { created: eightDaysAgo, updated: minuteAgo - i * 1000 });
    for (let i = 0; i < 51; i += 1) seed(row(`s_live_${pad(i)}`, "live"), { created: eightDaysAgo, updated: now - i * 1000 });
    check("two hundred and one rows the daemon is coming back to, under a cap of two hundred: none goes", own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 }), []);
    check("and nothing is said", reports, []);
    reset();
    for (let i = 0; i < 201; i += 1) seed(row(`s_pin_${String(i).padStart(3, "0")}`, "stopped", { pinned: true }), { created: eightDaysAgo, updated: eightDaysAgo + i * 1000 });
    for (let i = 0; i < 3; i += 1) seed(row(`s_pin_shutdown_${i}`, "daemon_shutdown"), { created: eightDaysAgo, updated: minuteAgo });
    seed(row("s_pin_live_a", "live"), { created: eightDaysAgo, updated: now });
    seed(row("s_pin_live_b", "live"), { created: eightDaysAgo, updated: minuteAgo });
    check(
      "two hundred and one pins beside five active rows: the cap takes the least recently touched pin and none of the five",
      own.sessions.prune({ retainMs: 1000 * 365 * DAY, maxSessions: 200, minSessions: 0 }),
      ["s_pin_000"],
    );
    seed(row("s_pin_plain", "stopped"), { created: now, updated: now });
    check(
      "and an unpinned inactive row goes before any pin, however recently it was touched",
      own.sessions.prune({ retainMs: 1000 * 365 * DAY, maxSessions: 200, minSessions: 0 }),
      ["s_pin_plain"],
    );

    // A given-up daemon_shutdown row ranks with the inactive rows; its twin, a live row carrying the column and an unknown value are never ranked.
    reset();
    for (let i = 0; i < 200; i += 1) seed(row(`s_gu_${String(i).padStart(3, "0")}`, "stopped"), { created: now, updated: minuteAgo + i * 1000 });
    seed(row("s_gu_given_up", "daemon_shutdown", { gaveUp: true }), { created: eightDaysAgo, updated: eightDaysAgo - 1000 });
    seed(row("s_gu_twin", "daemon_shutdown"), { created: eightDaysAgo, updated: eightDaysAgo - 1000 });
    seed(row("s_gu_live_gave_up", "live", { gaveUp: true }), { created: eightDaysAgo, updated: eightDaysAgo - 2000 });
    seed(row("s_gu_unknown_gave_up", "daemon_shutdown", { gaveUp: "daemon_upgraded" }), { created: eightDaysAgo, updated: eightDaysAgo - 2000 });
    check(
      "two hundred inactive rows and a daemon-stopped row the daemon has given up on, under a cap of two hundred: the given-up row is the one cut",
      own.sessions.prune({ retainMs: 1000 * 365 * DAY, maxSessions: 200, minSessions: 0 }),
      ["s_gu_given_up"],
    );
    check("while its twin, which the daemon is still coming back to, is not ranked under the cap at all", ids().includes("s_gu_twin"), true);
    check(
      "nor a live row carrying the column, nor one carrying a value this build cannot name, both touched less recently than anything it cut",
      [ids().includes("s_gu_live_gave_up"), ids().includes("s_gu_unknown_gave_up")],
      [true, true],
    );

    reset();
    for (let i = 0; i < 3; i += 1) seed(row(`s_say_idle_${i}`, "stopped"), stale);
    for (let i = 0; i < 202; i += 1) {
      seed(row(`s_say_fresh_${String(i).padStart(3, "0")}`, "stopped"), { created: now, updated: minuteAgo + i * 1000 });
    }
    const said = own.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 0 });
    check("one sentence, naming the count", reports.length === 1 && (reports[0] ?? "").includes("pruned 5 session(s)"), true);
    check("and the split", /3 idle past 7 day\(s\)/.test(reports[0] ?? "") && /2 over the 200-session cap/.test(reports[0] ?? ""), true);
    check("and every id", said.length === 5 && said.every((id) => (reports[0] ?? "").includes(id)), true);
    check("and that the transcripts went with them", (reports[0] ?? "").includes("with their transcripts"), true);
    check(
      "and what is never taken, rather than what is taken last — a live row, or one the daemon is still coming back to, which is narrower than interrupted now",
      (reports[0] ?? "").includes("A live session, or one the daemon is still coming back to, is never pruned"),
      true,
    );
    check(
      "and what the floor keeps, in rank order",
      (reports[0] ?? "").includes("rows stay at any age — active first, then pins, then the most recently touched"),
      true,
    );

    // A throwing sink must not change the returned list: daemon.ts sweeps upload directories from it.
    const loud = openStores({
      path: join(sandbox, "store", "prune-loud.db"),
      instanceId: "i_pruner_loud",
      onPruned: () => {
        throw new Error("the sink threw");
      },
    });
    for (let i = 0; i < 60; i += 1) {
      loud.sessions.put(row(`s_loud_${pad(i)}`, "stopped"));
      loud.db.prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?").run(eightDaysAgo, eightDaysAgo + i * 1000, `s_loud_${pad(i)}`);
    }
    const loudSaid = loud.sessions.prune({ retainMs: week, maxSessions: 200, minSessions: 50 }).sort();
    check("a sink that throws costs the caller nothing: the ten rows past the floor are returned", loudSaid, Array.from({ length: 10 }, (_, i) => `s_loud_${pad(i)}`));
    check("and are really gone", Number(loud.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.["n"]), 50);
    loud.close();

    // The daemon's own defaults, through an open with neither option: pinning the constant alone passes a bundle that defaults the floor to zero.
    const defaults = join(sandbox, "store", "prune-defaults.db");
    let bundle = openStores({ path: defaults, instanceId: "i_pruner_defaults" });
    const seedDefault = (i: number): void => {
      bundle.sessions.put(row(`s_def_${pad(i)}`, "stopped"));
      bundle.db.prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?").run(eightDaysAgo, eightDaysAgo + i * 1000, `s_def_${pad(i)}`);
    };
    for (let i = 0; i < 49; i += 1) seedDefault(i);
    bundle.close();
    bundle = openStores({ path: defaults, instanceId: "i_pruner_defaults" });
    check("forty-nine rows idle eight days survive an open with the daemon's own defaults", bundle.prunedSessions, []);
    check("and are all there", Number(bundle.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.["n"]), 49);
    for (let i = 49; i < 60; i += 1) seedDefault(i);
    bundle.close();
    bundle = openStores({ path: defaults, instanceId: "i_pruner_defaults" });
    check(
      "sixty do not: the open takes the ten least recently touched, off DEFAULT_RETAIN_MS and DEFAULT_MIN_SESSIONS",
      bundle.prunedSessions.sort(),
      Array.from({ length: 10 }, (_, i) => `s_def_${pad(i)}`),
    );
    check("and leaves fifty", Number(bundle.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.["n"]), 50);
    bundle.close();

    // Read off the entry script's text, since no in-process driver reaches scripts/daemon.ts.
    check("the floor is fifty", DEFAULT_MIN_SESSIONS, 50);
    const daemonWiring = readFileSync(new URL("../scripts/daemon.ts", import.meta.url), "utf8");
    check(
      "and the daemon reads REEMOAT_MIN_SESSIONS beside REEMOAT_MAX_SESSIONS",
      /maxSessions: positiveInt\(process\.env\["REEMOAT_MAX_SESSIONS"\]\),\s*minSessions: positiveInt\(process\.env\["REEMOAT_MIN_SESSIONS"\]\),/.test(daemonWiring),
      true,
    );
    check(
      "and prints what was pruned on its own line rather than as a degradation",
      /onPruned: \(detail\) => console\.log\(`store: \$\{detail\}`\)/.test(daemonWiring),
      true,
    );
    own.close();
  }

  // The route section stands an array in for the strip; only a real store shows that replace is atomic and the order survives a reopen.
  {
    const order = [
      { kind: "custom" as const, ref: "ca_11112222", hidden: false },
      { kind: "harness" as const, ref: "kimi", hidden: true },
      { kind: "harness" as const, ref: "claude", hidden: false },
    ];
    second.agentStrip.replace(order);
    check("a strip written to a real file reads back in order", second.agentStrip.list(), order);
    // Written back in reverse: without ORDER BY rank SQLite tends to return insertion order, which would disagree here.
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
    // Forgetting a missing position is not an error: DELETE /custom-agents/:id calls it for rows this build may not resolve.
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
    // hidden is stored as 1/0 and must read back as a boolean: a raw 1 compiles and is truthy but breaks the wire shape.
    second.agentStrip.replace([{ kind: "harness", ref: "codex", hidden: true }]);
    check(
      "hidden survives the round trip as a boolean",
      second.agentStrip.list().map((one) => typeof one.hidden + ":" + String(one.hidden)),
      ["boolean:true"],
    );
  }

  second.close();

  // A reopen: the strip table comes from schema.sql alone, with no migrate step, so it must be created on an existing file.
  const third = openStores({ path: dbPath, instanceId: "i_reopen" });
  check("the strip outlives the process that wrote it", third.agentStrip.list(), [
    { kind: "harness", ref: "codex", hidden: true },
  ]);
  third.close();
}

// The machine key is minted once and pinned by the control plane on first use, so a fresh key on a second start darkens the machine for good.
// Hence a real file, opened twice: a memory store cannot tell a Map from disk.
process.stdout.write("\nthe machine's own key\n");
{
  const keyPath = join(sandbox, "machinekey", "reemoat.db");

  const first = openStores({ path: keyPath, instanceId: "i_mk_a" });
  check("a machine that has never run answers no key at all", first.machineKeys.active(), null);
  const minted = ensureMachineKey(first.machineKeys, now);
  check("and generating one makes it the answer", first.machineKeys.active(), minted);
  first.close();

  // The private half is compared too: ensureMachineKey reads back after a save that does nothing on conflict, and kth alone passes without that read-back.
  const second = openStores({ path: keyPath, instanceId: "i_mk_b" });
  check("the same key comes back on the next start", ensureMachineKey(second.machineKeys, now + 60_000), minted);
  check(
    "and the second start wrote no second row",
    Number(second.db.prepare("SELECT count(*) AS n FROM machine_keys").get()?.["n"]),
    1,
  );

  // The length is the assertion because base64url decoding drops bad characters silently; the re-encode catches a different 32-byte string.
  for (const [half, value] of [
    ["public", minted.publicKey],
    ["private", minted.privateKey],
  ] as const) {
    const raw = Buffer.from(value, "base64url");
    report(
      `the ${half} half survives the TEXT round trip as 32 base64url bytes`,
      raw.length === 32 && raw.toString("base64url") === value,
      `${value.length} chars in the column, ${raw.length} bytes out`,
    );
  }

  check(
    "the row's name is the thumbprint of its own public half",
    minted.kth,
    jwkThumbprint(x25519Jwk(Buffer.from(minted.publicKey, "base64url"))),
  );

  // The ordering of active is load-bearing for a rotation that does not exist yet; overlap rows are inserted by hand, since ensureMachineKey refuses a second live key.
  const insert = second.db.prepare(
    "INSERT INTO machine_keys (kth, public_key, private_key, created_at, retired_at) VALUES (?, ?, ?, ?, ?)",
  );

  // machine_keys_one_live is the only way a daemon that lost a startup race learns it lost (two racers hash to different kth); asserted before the overlap drops it.
  let refusedSecondLive: string | null = null;
  try {
    insert.run("k_racer", "pub_racer", "sec_racer", now + 1, null);
  } catch (cause) {
    refusedSecondLive = cause instanceof Error ? cause.message : String(cause);
  }
  report(
    "a second live key is refused by the index rather than quietly stored",
    refusedSecondLive !== null && refusedSecondLive.includes("machine_keys_one_live"),
    refusedSecondLive ?? "the INSERT was accepted",
  );
  check("and the machine's key is still the one it minted", second.machineKeys.active()?.kth, minted.kth);

  // The index is dropped for the rest of this section, deliberately: the ordering is pinned for a future rotation, which is an overlap the index forbids.
  second.db.exec("DROP INDEX machine_keys_one_live");
  insert.run("k_newer", "pub_newer", "sec_newer", now + 1_000, null);
  check("a newer live row is the one a handshake answers on", second.machineKeys.active()?.kth, "k_newer");
  insert.run("k_aaa", "pub_aaa", "sec_aaa", now + 1_000, null);
  check("a same-millisecond tie is broken by the name, ascending", second.machineKeys.active()?.kth, "k_aaa");
  insert.run("k_zzz", "pub_zzz", "sec_zzz", now + 9_000, now + 9_500);
  check("a retired row is skipped however new it is", second.machineKeys.active()?.kth, "k_aaa");

  second.machineKeys.retire("k_aaa", now + 2_000);
  check("retiring the active key falls through to the next live row", second.machineKeys.active()?.kth, "k_newer");
  second.machineKeys.retire("k_newer", now + 2_000);
  check("and again, down to the key this machine generated", second.machineKeys.active()?.kth, minted.kth);
  // Retiring twice must not move retired_at: that moment is the only record of when a key stopped being announced.
  second.machineKeys.retire("k_aaa", now + 3_000);
  check(
    "and retiring one twice leaves the first answer standing",
    Number(second.db.prepare("SELECT retired_at AS t FROM machine_keys WHERE kth = 'k_aaa'").get()?.["t"]),
    now + 2_000,
  );

  // save does nothing on conflict: kth hashes the public half, and an upsert could overwrite a private key a live session already holds.
  second.machineKeys.save({
    kth: minted.kth,
    publicKey: "not-the-stored-public-half",
    privateKey: "not-the-stored-private-half",
    createdAt: now + 4_000,
  });
  check("saving a key that is already there changes nothing", second.machineKeys.active(), minted);
  second.close();
}

// The repair in migrateMachineKeysToOneLive, over a file already holding two live rows, which the section above never opens.
// The loser must be retired with its private half intact, and machineKeyRotation then promotes it once, where the migration guessed wrong.
process.stdout.write("\ntwo live machine keys, and who decides which one wins\n");
{
  const racePath = join(sandbox, "machinekey-race", "reemoat.db");
  mkdirSync(dirname(racePath), { recursive: true });

  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
  const kthOf = (key: { publicKey: Uint8Array }): string => jwkThumbprint(x25519Jwk(key.publicKey));
  // Real X25519 keypairs: machineKeyRotation hands its answer to localStaticKey, which refuses anything that is not 32 bytes.
  const older = generateStaticKey();
  const newer = generateStaticKey();

  {
    const seed = openStores({ path: racePath, instanceId: "i_race_seed" });
    seed.close();
  }
  {
    const raw = new DatabaseSync(racePath);
    raw.exec("DROP INDEX machine_keys_one_live");
    const insert = raw.prepare(
      "INSERT INTO machine_keys (kth, public_key, private_key, created_at, retired_at) VALUES (?,?,?,?,NULL)",
    );
    insert.run(kthOf(older), b64(older.publicKey), b64(older.secretKey), now);
    insert.run(kthOf(newer), b64(newer.publicKey), b64(newer.secretKey), now + 1_000);
    raw.close();
  }
  {
    // The non-vacuity half. Without it everything below would pass against a file
    // holding one row, i.e. against no race at all.
    const raw = new DatabaseSync(racePath);
    check(
      "the fixture really is a file with two live keys",
      Number(raw.prepare("SELECT count(*) AS n FROM machine_keys WHERE retired_at IS NULL").get()?.["n"]),
      2,
    );
    raw.close();
  }

  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  const repaired = openStores({ path: racePath, instanceId: "i_race_a" });
  console.error = realError;

  const liveCount = (db: DatabaseSync): number =>
    Number(db.prepare("SELECT count(*) AS n FROM machine_keys WHERE retired_at IS NULL").get()?.["n"]);
  check("the repair leaves exactly one live row", liveCount(repaired.db), 1);
  check("and it is the older of the two", repaired.machineKeys.active()?.kth, kthOf(older));
  report(
    "and it says so, and names the way back",
    said.some((line) => line.includes("live machine keys") && line.includes("clearkey")),
    said.length === 0 ? "nothing was printed" : said.join(" | "),
  );

  const loserRow = (db: DatabaseSync): Record<string, unknown> | undefined =>
    db.prepare("SELECT private_key, retired_at FROM machine_keys WHERE kth = ?").get(kthOf(newer)) as
      | Record<string, unknown>
      | undefined;
  const loser = loserRow(repaired.db);
  report(
    "the loser is retired rather than deleted, private half intact",
    loser !== undefined && String(loser["private_key"]) === b64(newer.secretKey) && loser["retired_at"] != null,
    loser === undefined ? "the row is gone" : `retired_at ${String(loser["retired_at"])}`,
  );
  check(
    "and the index the repair had to precede exists afterwards",
    Number(
      repaired.db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='machine_keys_one_live'")
        .get()?.["n"],
    ),
    1,
  );
  const retiredAt = loser === undefined ? null : Number(loser["retired_at"]);
  repaired.close();

  const again = openStores({ path: racePath, instanceId: "i_race_b" });
  const loserAgain = loserRow(again.db);
  check(
    "a second open leaves the moment it stopped being announced alone",
    loserAgain === undefined ? null : Number(loserAgain["retired_at"]),
    retiredAt,
  );

  check(
    "every key this machine has ever held is still readable, oldest first",
    again.machineKeys.all().map((key) => key.kth),
    [kthOf(older), kthOf(newer)],
  );
  const announcing = again.machineKeys.active();
  if (announcing === null) throw new Error("the race fixture lost its live key");
  const rotate = machineKeyRotation(again.machineKeys, announcing);
  const promoted = rotate();
  check("a 409 on the kept key promotes the other one this machine holds", promoted?.kth, kthOf(newer));
  check("and hands back the public half the next dial announces", promoted?.machineKey, b64(newer.publicKey));
  check("the store answers the promoted key from here on", again.machineKeys.active()?.kth, kthOf(newer));
  check("with exactly one row live throughout", liveCount(again.db), 1);
  // Finite: the booted key is in tried from the start and every candidate is added before promotion, so this can never loop.
  check("and nothing is ever offered twice", rotate(), null);

  // promote retires the incumbent before un-retiring the candidate (the index forbids the reverse), so an unknown kth must roll back or leave no live key.
  check("promoting a key that is not in the table answers false", again.machineKeys.promote("k_nobody"), false);
  check("and leaves the live row standing", again.machineKeys.active()?.kth, kthOf(newer));
  check("rather than leaving this machine with no key at all", liveCount(again.db), 1);

  // A different kth while a live row stands is the only way into save's conflict catch, and exactly what a daemon that lost the race produces.
  const stranger = generateStaticKey();
  let absorbed: string | null = null;
  try {
    again.machineKeys.save({
      kth: kthOf(stranger),
      publicKey: b64(stranger.publicKey),
      privateKey: b64(stranger.secretKey),
      createdAt: now + 6_000,
    });
  } catch (cause) {
    absorbed = cause instanceof Error ? cause.message : String(cause);
  }
  report("a second live key is absorbed rather than thrown", absorbed === null, absorbed ?? "no throw");
  check("and the machine still answers the key it had", again.machineKeys.active()?.kth, kthOf(newer));
  check(
    "and absorbed means nothing was written",
    Number(
      again.db.prepare("SELECT count(*) AS n FROM machine_keys WHERE kth = ?").get(kthOf(stranger))?.["n"],
    ),
    0,
  );

  // Negative control: isLiveMachineKeyConflict matches the index name, so any other constraint must still throw.
  let otherFailure: string | null = null;
  try {
    again.machineKeys.save({
      kth: "k_null_public",
      publicKey: null as unknown as string,
      privateKey: "whatever",
      createdAt: now + 7_000,
    });
  } catch (cause) {
    otherFailure = cause instanceof Error ? cause.message : String(cause);
  }
  report(
    "but a constraint that is not the live-row index is still thrown",
    otherFailure !== null && !otherFailure.includes("machine_keys_one_live"),
    otherFailure ?? "it was swallowed",
  );
  again.close();

  const lonePath = join(sandbox, "machinekey-lone", "reemoat.db");
  mkdirSync(dirname(lonePath), { recursive: true });
  const lone = openStores({ path: lonePath, instanceId: "i_lone" });
  const loneKey = ensureMachineKey(lone.machineKeys, now);
  check("a machine holding one key has nothing to promote", machineKeyRotation(lone.machineKeys, loneKey)(), null);
  check("and nothing was retired finding that out", lone.machineKeys.active()?.kth, loneKey.kth);
  check("nor anything created", lone.machineKeys.all().length, 1);
  lone.close();
}

// Read off the files, comment-stripped, since no in-process driver reaches scripts/daemon.ts or the tunnel's 409 arm.
// machineKey and staticKey are one key's halves, so nothing may read the pair the tunnel was started with.
process.stdout.write("\nwhere the promoted key is actually announced\n");
{
  // Block and whole-line comments only: stripping to end of line would eat the https:// inside a string.
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const daemonEntry = withoutComments(readFileSync(new URL("../scripts/daemon.ts", import.meta.url), "utf8"));
  const tunnelSrc = withoutComments(readFileSync(new URL("../src/relay/tunnel.ts", import.meta.url), "utf8"));

  check(
    "the daemon hands the tunnel a rotation over its own machine-key store",
    /rotateMachineKey:\s*machineKeyRotation\(stores\.machineKeys,\s*machineKey\)/.test(daemonEntry),
    true,
  );
  check(
    "and the 409 arm is what spends it, inside the guard that keeps it from escaping",
    /status === 409\s*\)\s*\{[\s\S]{0,240}?try\s*\{\s*promoted = this\.options\.rotateMachineKey\?\.\(\) \?\? null;\s*\}\s*catch/.test(
      tunnelSrc,
    ),
    true,
  );
  check(
    "moving both halves of the key together",
    /this\.machineKey = promoted\.machineKey;\s*this\.staticKey = promoted\.staticKey;/.test(tunnelSrc),
    true,
  );
  report(
    "and nothing in the tunnel reads the pair it was started with again",
    !/this\.options\.machineKey/.test(tunnelSrc) && !/this\.options\.staticKey/.test(tunnelSrc),
    "the dial header and the Noise responder both read the rotated fields",
  );
  // Non-vacuity for all four: a stripper that ate the file would satisfy every absence above.
  report(
    "and both files really were read",
    daemonEntry.includes("RelayTunnel.start({") && tunnelSrc.includes("export class RelayTunnel"),
    `${daemonEntry.length} and ${tunnelSrc.length} chars after stripping`,
  );
}

// Only a real dial shows the second dial carries the promoted key: tunnels with a rotator, with none, and with one that throws.
// random returns 0 once to collapse the first backoff, then 1 so a finished tunnel parks.
process.stdout.write("\nthe second dial, against a relay that answers 409\n");
{
  /** The words an operator reads when there is nothing left to try. Pinned, not paraphrased. */
  const TERMINAL_409 =
    "relay refused the tunnel: this machine announced an encryption key that does not match " +
    "the one the control plane pinned for it, so nothing can reach it and retrying will not help. " +
    "Re-enroll this machine, or have an operator run `cpctl admin clearkey <machineId>`.";

  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
  const booted = generateStaticKey();
  const other = generateStaticKey();

  const announced: Array<string | undefined> = [];
  const relay = createServer();
  relay.on("upgrade", (request, socket) => {
    const header = request.headers[MACHINE_KEY_HEADER];
    announced.push(Array.isArray(header) ? header.join(",") : header);
    // A raw status line: an upgrade has no ServerResponse, and a 409 here is what puts the client into unexpected-response.
    socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.end();
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  /** Zero once — collapse the first backoff — then the top of the window, so a finished tunnel parks. */
  const collapseFirstBackoff = (): (() => number) => {
    let first = true;
    return () => {
      if (!first) return 1;
      first = false;
      return 0;
    };
  };
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      if (done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return done();
  };

  /* 1. Two keys on this disk: the refusal is believed and the other one is announced. */
  {
    let offers = 0;
    const said: string[] = [];
    const tunnel = RelayTunnel.start({
      relayUrl,
      tunnelKey: "tk_fixture",
      local: { host: "127.0.0.1", port: 1 },
      machineKey: b64(booted.publicKey),
      staticKey: localStaticKey(booted.secretKey),
      rotateMachineKey: () => {
        offers += 1;
        return offers === 1
          ? { kth: "k_other", machineKey: b64(other.publicKey), staticKey: localStaticKey(other.secretKey) }
          : null;
      },
      random: collapseFirstBackoff(),
      onEvent: (kind, detail) => {
        if (kind === "rejected") said.push(detail);
      },
    });
    const reached = await until(() => announced.length >= 2 && said.length >= 2);
    await tunnel.stop();
    report("a relay answering 409 is dialled twice", reached, `${announced.length} dials, ${said.length} said`);
    check("the first dial announces the key the daemon booted on", announced[0], b64(booted.publicKey));
    check("and the second announces the promoted one", announced[1], b64(other.publicKey));
    report(
      "the operator is told which key is live now",
      said[0] !== undefined && said[0].includes("k_other is live now and the next dial announces it"),
      said[0] ?? "nothing was said",
    );
    check("and an exhausted walk reaches the sentence it always reached", said[1], TERMINAL_409);
  }

  /* 2. One key on this disk, which is every legitimate 409. Nothing may have changed. */
  {
    announced.length = 0;
    const said: string[] = [];
    const tunnel = RelayTunnel.start({
      relayUrl,
      tunnelKey: "tk_fixture",
      local: { host: "127.0.0.1", port: 1 },
      machineKey: b64(booted.publicKey),
      staticKey: localStaticKey(booted.secretKey),
      // Absent rather than a rotator returning null: a daemon predating the rotation passes nothing, and the two must be indistinguishable.
      random: collapseFirstBackoff(),
      onEvent: (kind, detail) => {
        if (kind === "rejected") said.push(detail);
      },
    });
    const reached = await until(() => announced.length >= 2 && said.length >= 2);
    await tunnel.stop();
    report("a tunnel with no rotator still dials twice", reached, `${announced.length} dials, ${said.length} said`);
    check("and says the same thing both times", said.slice(0, 2), [TERMINAL_409, TERMINAL_409]);
    check(
      "announcing the same key, because nothing on this machine moved",
      announced.slice(0, 2),
      [b64(booted.publicKey), b64(booted.publicKey)],
    );
  }

  /* 3. The rotator throws — `SQLITE_BUSY` on a dial path whose own writers are live. */
  {
    announced.length = 0;
    const said: string[] = [];
    const tunnel = RelayTunnel.start({
      relayUrl,
      tunnelKey: "tk_fixture",
      local: { host: "127.0.0.1", port: 1 },
      machineKey: b64(booted.publicKey),
      staticKey: localStaticKey(booted.secretKey),
      rotateMachineKey: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      random: collapseFirstBackoff(),
      onEvent: (kind, detail) => {
        if (kind === "rejected") said.push(detail);
      },
    });
    // Reaching this line is the assertion: without the guard in the tunnel's 409 arm the throw is uncaught and the process dies.
    const reached = await until(() => said.length >= 2);
    await tunnel.stop();
    report("a rotator that throws does not take the daemon with it", reached, said.join(" | ") || "nothing was said");
    report(
      "the cause is said rather than swallowed",
      said[0] !== undefined && said[0].includes("SQLITE_BUSY: database is locked"),
      said[0] ?? "nothing was said",
    );
    check("and it degrades to exactly the pre-rotation sentence", said[1], TERMINAL_409);
    report(
      "and the daemon is still dialling",
      announced.length >= 2,
      `${announced.length} dials after the throw`,
    );
  }

  await new Promise<void>((resolve) => relay.close(() => resolve()));
}

// takeDaemonRow's compare-and-set, both halves: a stale observation must lose with the racer's row standing, and a matching one must win.
process.stdout.write("\nthe daemon lock's compare-and-set\n");
{
  const lockPath = join(sandbox, "daemon-cas", "reemoat.db");
  mkdirSync(dirname(lockPath), { recursive: true });
  const held = openStores({ path: lockPath, instanceId: "i_cas_winner" });
  const rowNow = (): DaemonRow | null => {
    const row = held.db.prepare("SELECT instance_id, pid, started_at FROM daemon WHERE id = 1").get();
    if (!row) return null;
    return {
      instanceId: String(row["instance_id"]),
      pid: Number(row["pid"]),
      startedAt: Number(row["started_at"]),
    };
  };
  const winner = rowNow();
  check("opening the store claimed the row", winner?.instanceId, "i_cas_winner");

  const claimant: DaemonRow = { instanceId: "i_cas_loser", pid: process.pid, startedAt: now };
  check("a claim from a racer that observed an empty table loses", takeDaemonRow(held.db, claimant, null), false);
  check(
    "and so does one that observed a row that has since moved",
    takeDaemonRow(held.db, claimant, { instanceId: "i_ghost", pid: 999_999, startedAt: 1 }),
    false,
  );
  check("the winner's row is untouched by either", rowNow()?.instanceId, "i_cas_winner");
  check("a claim that observed exactly what is there takes the row", takeDaemonRow(held.db, claimant, winner), true);
  check("and the row is the claimant's afterwards", rowNow(), claimant);
  held.close();
}

// machine_keys comes from schema.sql re-applied on every open, with no SCHEMA_VERSION bump: an upgraded file must gain the table and hold no key yet.
{
  const upgradeDir = join(sandbox, "pre-machinekeys");
  const upgradePath = join(upgradeDir, "reemoat.db");
  mkdirSync(upgradeDir, { recursive: true });
  {
    const raw = new DatabaseSync(upgradePath);
    raw.exec("PRAGMA journal_mode = WAL");
    // Stamped at this build's version with the table absent: the shape of a file from the release before machine_keys.
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    raw.close();
  }
  const tableCount = (db: DatabaseSync): unknown =>
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='machine_keys'").get()?.["n"];
  {
    const raw = new DatabaseSync(upgradePath);
    check("the fixture really is a file with no machine_keys table", tableCount(raw), 0);
    raw.close();
  }
  const upgraded = openStores({ path: upgradePath, instanceId: "i_mk_upgrade" });
  check("an upgraded file gains the table on open", tableCount(upgraded.db), 1);
  check("and the machine has no key until it generates one", upgraded.machineKeys.active(), null);
  check(
    "and the version does not move for it",
    Number(upgraded.db.prepare("PRAGMA user_version").get()?.["user_version"]),
    SCHEMA_VERSION,
  );
  const afterUpgrade = ensureMachineKey(upgraded.machineKeys, now);
  report(
    "and a key generated on that file is one the row really holds",
    JSON.stringify(upgraded.machineKeys.active()) === JSON.stringify(afterUpgrade),
    `kth ${afterUpgrade.kth.slice(0, 10)}…, created_at ${afterUpgrade.createdAt}`,
  );
  upgraded.close();
}

// Real git rather than a stub: every rule here is about what git actually prints.
process.stdout.write("\nwhat a session changed\n");
{
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  // -c for identity and --initial-branch, so the host's git defaults cannot pick a branch this driver did not choose.
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, "-c", "user.name=daemoncheck", "-c", "user.email=d@example.invalid", ...args], {
      stdio: "pipe",
    });
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { stdio: "pipe" });
  // Pinned in the repo's own config: gitEnv forwards HOME, so a global diff.renames, diff.noprefix or diff.mnemonicPrefix would change what the parsers see.
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

  writeFileSync(join(repo, "kept.txt"), "one\nTWO CHANGED\nthree\n");
  execFileSync("git", ["-C", repo, "mv", "moves.txt", "moved.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "rm", "--quiet", "gone.txt"], { stdio: "pipe" });
  writeFileSync(join(repo, "fresh.txt"), "brand new\n");
  // The name that broke the header rewrite. `$&` is the whole match in a string
  // replacement, so a path carrying it spliced the absolute path back in.
  writeFileSync(join(repo, "a$&b.txt"), "dollar ampersand\n");
  // An untracked file with a NUL: an untracked path has no blob, so only reading its bytes can classify it.
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  symlinkSync(join(repo, "kept.txt"), join(repo, "link.txt"));
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

    // Untracked binary detection runs in markBinary after the cap, through probeBinary's deadline, never synchronously in the parser.
    check("an untracked file with a NUL in it is binary", byPath.get("blob.bin")?.binary, true);
    check("and an untracked text file is not", byPath.get("fresh.txt")?.binary, false);
    check("a removal is deleted", byPath.get("gone.txt")?.status, "deleted");

    // A shared path-token helper would be a bug: porcelain v2 emits new then orig, while diff --raw and --numstat emit src then dst.
    check("a rename is renamed", byPath.get("moved.txt")?.status, "renamed");
    check("naming where it came from, not just where it went", byPath.get("moved.txt")?.oldPath, "moves.txt");
    check("and never the other way round", byPath.get("moves.txt"), undefined);

    // symlink comes only from a tracked path's mode (untracked records carry none), so it is a hint; diffFile's own lstat is what stops a link being followed.
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
    // diff --no-index exits 1 when the files differ, which is the success case for every new file.
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
    // A function replacement: a string replacement expands $& and friends, and the path is the agent's choice.
    const diff = await diffFile(workspace, changeFor("a$&b.txt"), diffOpts);
    check("a path with $& in it rewrites to itself", diff.patch?.includes("+++ b/a$&b.txt"), true);
    check("and does not splice the absolute path back in", diff.patch?.includes(repo), false);
  }

  {
    // git C-quotes non-ASCII, quote and backslash names, so both header path lines are replaced outright rather than prefix-matched.
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
      check("and the two header lines agree", diff.patch?.includes(`diff --git a/${odd} b/${odd}`), true);
      check("with the absolute path nowhere in it", diff.patch?.includes(repo), false);
    }
  }

  {
    // Never content-diffed: diff --no-index follows the link, so a link to ~/.ssh/id_rsa would serve its bytes; lstat, never stat.
    const diff = await diffFile(workspace, changeFor("link.txt"), diffOpts);
    check("a symlink is never content-diffed", diff.kind, "symlink");
    check("it reports where it points instead", diff.symlinkTarget, join(repo, "kept.txt"));
    check("and carries no patch at all", diff.patch, null);
    // The target's content must reach no field of the answer, not merely leave patch null.
    check("so the target's contents are not served, in any field", JSON.stringify(diff).includes("TWO CHANGED"), false);
  }

  {
    const capped = await listChanges(workspace, { runner: hostGit, base: "session", includeIgnored: false, limit: 2 });
    check("a file cap cuts the list", capped.supported && capped.files.length, 2);
    check("and says so rather than reading as complete", capped.supported && capped.truncated?.reason, "file_limit");
    check("naming the limit it hit", capped.supported && capped.truncated?.limit, 2);

    // A cut patch ends at the last complete line, so a cap too tight for one line yields nothing; both ends asserted.
    const clipped = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 120 });
    check("a byte cap cuts a patch", clipped.truncated, true);
    check("and what is left is shorter than the whole", (clipped.patch?.length ?? 0) < (await diffFile(workspace, changeFor("kept.txt"), diffOpts)).patch!.length, true);
    check("ending on a line break rather than mid-line", clipped.patch?.endsWith("\n"), true);

    const starved = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 16 });
    check("a cap too tight for one whole line carries no patch", starved.patch, null);
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

  {
    // git diff reports repo-root-relative paths and git status cwd-relative ones; they differ only for a plain session in a subdirectory, driven here.
    const nested = join(repo, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "inner.txt"), "one\n");
    // The git helper, not a bare execFileSync: a commit without its -c identity fails on a host with no global git config, such as CI.
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
    const inner = listed.supported ? listed.files.find((f) => f.path === "inner.txt") : undefined;
    // Asserted through inner !== undefined, never optional chaining: undefined !== null is true, so a missing row would pass.
    check("the listing has that row at all", inner !== undefined, true);
    check("carrying the numstat that only `diff` knows", inner !== undefined && inner.added !== null && inner.deleted !== null, true);
    check("and the status that only `status` knows", inner !== undefined && inner.xy !== null, true);
    check("an untracked file in the same tree is addressable", listed.supported && listed.files.find((f) => f.path === "new.txt")?.addressable, true);
    const outside = listed.supported ? listed.files.find((f) => f.path.startsWith("../")) : undefined;
    check("a change outside the tree is still shown", outside !== undefined, true);
    check("and marked as one nobody can ask about", outside?.addressable, false);

    if (inner) {
      const patch = await diffFile(sub, inner, diffOpts);
      check("the diff route answers for a path from that listing", patch.kind, "text");
      check("and its header names the path the caller asked for", patch.patch?.includes("a/inner.txt"), true);
      check("never the repository-relative one", patch.patch?.includes("nested/inner.txt"), false);
    }
  }
}

// A worktree root that traverses a symlink must still accept a leaf that does not exist yet.
// Built explicitly: /tmp is a symlink on macOS but not on the Linux CI.

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
      return { made: null, code: error instanceof WorktreeError ? error.code : String(error) };
    }
  };

  const first = await make("s_sym", linkedRoot);
  check("a root that traverses a symlink is not outside itself", first.code, null);
  check("and the session really gets a worktree", first.made?.workspace.mode, "worktree");
  check("under the root it was asked for, as written", first.made?.workspace.root.startsWith(`${linkedRoot}/`), true);
  check("on a branch this daemon created", first.made?.workspace.git?.createdBranch, true);
  check("and it resolves inside the real one too", containedIn(first.made?.workspace.root ?? "", realRoot), true);

  // The control: a per-repository directory replaced by a symlink is refused by lstat on the component, since an agent can compute repoKey.
  const repoDir = dirname(first.made?.workspace.root ?? join(linkedRoot, "none"));
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", "--", first.made?.workspace.root ?? ""], {
    stdio: "pipe",
  });
  rmSync(repoDir, { recursive: true, force: true });
  symlinkSync(uAbcd, repoDir);
  const second = await make("s_sym2", linkedRoot);
  check("but a per-repository directory that is a symlink is still refused", second.code, "outside_worktree_root");
}

// count and countStatus answer null for could-not-tell, and removeWorkspace must refuse on it rather than read zero; force overrides both.
// The runner is scripted because git has to fail to answer; each case ends by checking the work is still on disk.

process.stdout.write("\nrefusing to remove a worktree on a count nobody could take\n");
{
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
  const refusalsOf = (result: Awaited<ReturnType<typeof removeWorkspace>>): string[] =>
    result.kind === "refused"
      ? result.refusals.map((refusal) => `${refusal.code}${"about" in refusal ? `:${refusal.about}` : ""}`)
      : [`(${result.kind})`];
  const ran = (argv: string[][], verb: string, sub?: string): boolean =>
    argv.some((args) => args[0] === verb && (sub === undefined || args[1] === sub));

  {
    // The commit count, the irreversible one: rev-list fails and there are no remotes, so orphaned is unknown right before branch deletion.
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
    check("the checkout is still there", existsSync(join(workspace.root, "work.txt")), true);
    check("git was never asked to remove it", ran(git.argv(), "worktree", "remove"), false);
    check("and the branch was never deleted", ran(git.argv(), "branch"), false);
  }

  {
    // A failing status must refuse too, but only while the directory exists: a genuinely gone one has nothing to hold.
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
    // git declining the removal is a refusal, never a warning followed by rm; recognised by git's own words, as classifyAddFailure does.
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
    check("and the work git would not delete is still on disk", existsSync(join(workspace.root, "work.txt")), true);
    // Skipping the prune is safe and deliberate: a worktree git has just declined
    // to remove is still registered and still present, so there is nothing stale.
    check("nothing was pruned on the way past", ran(git.argv(), "worktree", "prune"), false);
  }

  {
    // The control: without it every assertion above passes for a removeWorkspace that refuses everything.
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

  // scripts/client.ts prints only error.message, so the route's sentence is the answer: an unmeasured count must not claim work is here.

  // Starts as a git that answers everything, so a case that forgets its own fails as a 200 rather than inheriting refusals.
  let routeGit: GitExec = scriptedGit({ status: "empty", revList: "0", remotes: "" }).runner;
  class ScriptedGitRuntime extends LocalRuntime {
    // Delegates per call: createApp reads the runtime's git once, at construction.
    override git(): GitExec {
      return {
        run: (args, options) => routeGit.run(args, options),
        readCapped: (args, options) => routeGit.readCapped(args, options),
      };
    }
  }

  // rowFor ends stopped, the precondition: the route refuses a live session before asking git anything.
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
    routeGit = scriptedGit({ status: "empty", revList: "throw", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_unknown", "deleteBranch=1");
    check("a refusal nobody could measure is still a 409", refused.status, 409);
    check("but not one that claims there is work here", refused.code, "workspace_uncertain");
    check("and the sentence says which of the two it is", refused.message, "could not tell whether removing this worktree would lose work; force removes it anyway");
    // The remedy travels in the sentence: the CLI hangs its hint off workspace_dirty, which this code is not.
    check("with the remedy in it, which the code no longer carries", refused.message.includes("force"), true);
    check("and the refusals themselves still ride along", refused.refusals, ["counts_unknown"]);
  }

  {
    // The mixed case: a definite refusal wins over an unmeasured one, since "still holds work" is then true.
    routeGit = scriptedGit({ status: "throw", revList: "3", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_mixed", "deleteBranch=1");
    check("a refusal that did measure something says so", [refused.status, refused.code], [409, "workspace_dirty"]);
    check("in the words this arm always used", refused.message, "this worktree still holds work");
    check("with both refusals carried, in the order they were found", refused.refusals, ["counts_unknown", "unpushed_commits"]);
  }
}

process.stdout.write("\nthe transcript on disk\n");
{
  const evPath = join(sandbox, "events", "reemoat.db");
  const text = (n: number): SessionEvent => ({ type: "text", role: "agent", thought: false, text: `e${n}`, messageId: null });

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
    // Eviction takes a prefix, which the counters derived at load rely on; asserted as relationships, since the slack clamp sets the literal counts.
    const evictPath = join(sandbox, "evict", "reemoat.db");
    const store = openStores({ path: evictPath, instanceId: "i_evict", maxEventsPerSession: 8 });
    for (let n = 1; n <= 10; n += 1) store.events.append("s_full", text(n));

    const stats = store.events.stats("s_full");
    check("the newest seq is every event ever appended", stats.lastSeq, 10);
    check("something was evicted", stats.count < 10, true);
    check("and everything is accounted for, dropped plus kept", stats.dropped + stats.count, 10);
    check("what survives begins one past what was dropped", stats.firstSeq, stats.dropped + 1);
    const survivors = store.events.read("s_full", 0, 100, 1 << 20);
    check("and runs contiguously to the newest", survivors.map((stored) => stored.seq), [
      ...Array.from({ length: survivors.length }, (_, i) => stats.firstSeq + i),
    ]);
    check("the oldest event is gone", (survivors[0]?.event as { text: string }).text !== "e1", true);
    check("and the newest is not", (survivors.at(-1)?.event as { text: string }).text, "e10");
    // Never the last row: `lastSeq = MAX(seq)` has to stay derivable at load.
    check("eviction never takes the newest row", stats.count >= 1, true);
    store.close();
  }

  {
    // By default eviction never runs: driven past 5000 events and past 8 MiB, since count and bytes are separate conditions in evict.
    const keepPath = join(sandbox, "keep", "reemoat.db");
    const store = openStores({ path: keepPath, instanceId: "i_keep" });
    const padding = "x".repeat(2_048);
    for (let n = 1; n <= 6_000; n += 1) {
      store.events.append("s_keep", { type: "text", role: "agent", thought: false, text: `e${n}${padding}`, messageId: null });
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
    // Without seedFloors a session whose events are all gone restarts at seq 1, and a reconnect replays different events under seen numbers.
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
    // firstSeq is 0 with no rows, so the gap predicate, the wire and the snapshot must all go through oldestAvailable.
    check("with rows, the oldest readable seq is the oldest row", oldestAvailable({ firstSeq: 7, lastSeq: 20, count: 14 }), 7);
    check(
      "with none, it is one past the end rather than minus one",
      oldestAvailable({ firstSeq: 0, lastSeq: 500, count: 0 }),
      501,
    );
    check("and an untouched session asks to be served from the start", oldestAvailable({ firstSeq: 0, lastSeq: 0, count: 0 }), 1);
  }

  {
    // A failed write becomes a placeholder at the same seq, and append returns it: a hole is invisible, and a live/replay mismatch undetectable.
    // A cycle survives truncateEvent and then throws in JSON.stringify.
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
    // The per-event ceiling is applied at the store boundary, and truncation is marked so it never reads as something the agent said.
    const bigPath = join(sandbox, "big", "reemoat.db");
    const store = openStores({ path: bigPath, instanceId: "i_big", maxEventBytes: 2048 });
    const stored = store.events.append("s_big", { type: "text", role: "agent", thought: false, text: "x".repeat(20_000) , messageId: null });
    const kept = (stored.event as { text: string }).text;
    check("an oversized event is clipped rather than refused", kept.length < 20_000, true);
    check("and says so, with this repo's own marker", /\[truncated \d+ bytes\]$/.test(kept), true);
    check("the clipped form is what lands on disk too", (store.events.read("s_big", 0, 10, 1 << 20)[0]?.event as { text: string }).text, kept);
    store.close();
  }
}

// An upgrade that touches the secret tables: agent_credentials is rewritten (duplicates collapse, newest wins).
// forge_accounts is dropped, since nothing can revoke its tokens any more, and migrate says so on stderr.
process.stdout.write("\nthe v6 migration\n");
{
  const v5Path = join(sandbox, "v5", "reemoat.db");
  mkdirSync(join(sandbox, "v5"), { recursive: true });

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

  // stderr is captured: the drop and the collapse are the only places this upgrade tells anybody it destroyed something.
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
  check("a collision keeps the newer secret", migrated.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-NEWER",
  });

  // A new table needs only schema.sql, and SCHEMA_VERSION must not move: refuseNewerSchema would make every rollback fail to start.
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

  // The tiebreak on owner_subject only decides same-millisecond updates, so it needs a forced tie.
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
    // A table a v6 migrate would drop on sight: its survival proves a newer file is refused before anything is written.
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
