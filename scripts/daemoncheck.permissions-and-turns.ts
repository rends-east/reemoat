import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { MemoryEventStore, type PersistedSession } from "../src/events.js";
import { SessionRegistry, awaitingHuman } from "../src/registry.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { tmp } from "./tmp.js";
import { check, report } from "./daemoncheck.env.js";
import {
  users,
  now,
  tokenFor,
  verifier,
  storeOf,
  rowFor,
  credentials,
  stubAgentConfig,
} from "./daemoncheck.fixtures.js";

/*
 * Answering the agent, which is the interaction this whole product exists for
 * and the one nothing reached.
 *
 * Every route in this file could be exercised against a restored row because a
 * restored row is a *record*. A permission is not: it is a live `resolve`
 * closure held open across an HTTP request, so nothing short of a real agent
 * asking a real question could get near it. That is why it went uncovered, and
 * it is why the fake agent below **waits** — the turn does not end until the
 * answer comes back, so the assertions are about a session that is genuinely
 * blocked rather than one that once was.
 *
 * The statement order inside `settle` is the load-bearing part and it is
 * asserted through its only observable consequence: the agent gets the option id
 * a client chose. `pending.delete` is the compare-and-swap, and the agent is
 * unblocked *before* anything is logged — a throw while appending would
 * otherwise leave the request recorded as answered, gone from `pending`, and the
 * agent's RPC never responded to. That is a permanent hang which also switches
 * off `status: "blocked"`, the one signal that would have revealed it.
 */
/**
 * Answering a permission over HTTP, shared by the two blocks that do it.
 *
 * One helper rather than two near-identical closures: the block below and the
 * expired-id block after it built the same `Request`, the same bearer header and
 * the same response tail, differing only in which app and which session.
 *
 * **The parse is deliberately defensive**, for the same reason `waitingOn` exists
 * one screen down. Not every non-2xx this route can produce is JSON — an id that
 * is not a path segment leaves Hono matching no route and answering its own
 * plain-text `404 Not Found` — and a `JSON.parse` that throws here takes the
 * process down mid-run, deleting every later section's coverage instead of
 * failing one case. Measured, by writing exactly that bug and hitting it.
 */
const answerPermission = async (
  // Hono's own `fetch` is `Response | Promise<Response>`, and narrowing it here
  // to the promise alone is a type error at both call sites rather than at this
  // one — `await` copes with either.
  target: { fetch: (request: Request) => Response | Promise<Response> },
  sessionId: string,
  permissionId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await target.fetch(
    new Request(`http://d/sessions/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (text.length === 0) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    // Reported as a value rather than thrown, so a case can assert on it.
    return { status: response.status, body: { nonJsonBody: text } };
  }
};

process.stdout.write("\nanswering a permission the agent is waiting on\n");
{
  // Only the SDK is loaded here. `LocalRuntime`, `SessionRegistry`,
  // `MemoryEventStore`, `PassThrough`, `tmp` and `join` are all imported at the
  // top of this file already, and re-importing them read as a deliberate
  // deferral of something that is not deferred.
  const acp = await import("@agentclientprotocol/sdk");

  /**
   * What the client sent back, in the agent's own words.
   *
   * Typed structurally rather than as `acp.RequestPermissionResponse`: `acp` is
   * a dynamic import here, so it is a value and not a namespace, and the only
   * field any assertion below reads is the one the agent was waiting for.
   */
  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  /**
   * A fresh pipe pair per launch, because two sessions means two agents.
   *
   * One pair shared between them would put two `AcpClient`s on one stream and
   * cross their routing — the same reason `rigWith` builds its own per launch.
   *
   * Typed as `AgentProcess` rather than `any`, which is the whole reason
   * `src/runtime/types.ts` keeps that interface with one implementation: adding a
   * member to it has to fail `pnpm typecheck` *here*, in the driver that
   * substitutes its own runtime, or the seam is documented and unenforced.
   */
  let launches = 0;
  const spawnAgent = (): AgentProcess => {
    launches += 1;
    const mine = launches;
    const sessionId = `s_perm_${mine}`;
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    /** The prompt whose turn is being held open by an unanswered permission. */
    let heldPromptId: unknown = null;
    let askId = 9000;
    /** Which options the *next* request offers, so one agent can pose several. */
    let offer: { optionId: string; name: string; kind: string }[] = [];

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // A response rather than a call: this is the answer to the permission
        // this agent asked for, and the turn has been waiting on it.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "end_turn" } });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.prompt: {
            // The prompt text chooses the option set, so one agent can pose
            // several differently-shaped questions across several turns.
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            /*
             * The second agent never asks; it exists to be the row a cut has to
             * drop in favour of the blocked one.
             *
             * `run it` is the override, and it is the policy block's door in:
             * that block needs a *third* agent that does ask, and keying which
             * spawn asks purely on its ordinal made "which session number am I"
             * a hidden coupling between two sections of this file.
             */
            if (mine !== 1 && !text.includes("run it")) {
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              break;
            }
            offer = text.includes("narrow")
              ? [{ optionId: "o_yes", name: "Yes", kind: "allow_once" }]
              : [
                  { optionId: "o_yes", name: "Yes", kind: "allow_once" },
                  { optionId: "o_always", name: "Always", kind: "allow_always" },
                  { optionId: "o_no", name: "No", kind: "reject_once" },
                  { optionId: "o_never", name: "Never", kind: "reject_always" },
                ];
            /*
             * The three shapes an agent can send that nothing used to bound, and
             * they are here rather than in a pure case because the whole defect
             * was that the *route from the wire to the snapshot* had no cap on
             * it. Asserting `clip` would have passed all along.
             *
             * `wordy` is the pair `shouting` used to be half of. The two 200-char
             * clips are gone — a clipped `name` broke `askedQuestion`'s identity
             * match against `rawInput`, which is how a kimi question fell back to
             * buttons — so a long-but-reasonable option name has to arrive whole,
             * and only the *pair's* byte weight refuses.
             */
            if (text.includes("wordy")) {
              offer = [
                { optionId: "o_yes", name: `Yes, and ${"scope ".repeat(60)}`.trim(), kind: "allow_once" },
                { optionId: "o_no", name: "No", kind: "reject_once" },
              ];
            }
            if (text.includes("shouting")) {
              offer = [{ optionId: "o_yes", name: "Y".repeat(4_000), kind: "allow_once" }];
            }
            if (text.includes("in Chinese")) {
              offer = [{ optionId: "o_yes", name: "好", kind: "allow_once" }];
            }
            if (text.includes("swarming")) {
              offer = Array.from({ length: 200 }, (_, i) => ({
                optionId: `o_${i}`,
                name: `Option ${i}`,
                kind: i === 0 ? "allow_once" : "reject_once",
              }));
            }
            heldPromptId = id;
            askId += 1;
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.session.requestPermission,
              params: {
                sessionId,
                toolCall: {
                  toolCallId: `tc_${mine}_${askId}`,
                  title: text.includes("shouting")
                    ? "T".repeat(50_000)
                    : text.includes("in Chinese")
                      ? "運".repeat(8_000)
                      : text.includes("wordy")
                        ? `Run ${"a long deliberate title ".repeat(20)}`.trim()
                        : "Terminal",
                  rawInput: { command: "rm -rf /" },
                  content: [{ type: "content", content: { type: "text", text: "Requesting approval to run it" } }],
                },
                options: offer,
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class PermissionRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const permRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new PermissionRuntime());
  const { app: permApp } = createApp({
    registry: permRegistry,
    verifier,
    instanceId: "i_perm",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const answer = (sessionId: string, permissionId: string, body: unknown) =>
    answerPermission(permApp, sessionId, permissionId, body);

  /**
   * Long enough for a prompt to reach the pipes and the request to come back.
   *
   * Named `quiesce` rather than `settle` deliberately: `SessionRegistry.settle` is
   * the *subject* of this whole block, argued about three lines above in prose, so
   * one word for the method under test and for a timeout beside it is exactly the
   * collision this file spends paragraphs avoiding elsewhere.
   */
  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  /**
   * The id of the question the agent is waiting on, or `""` when there is none.
   *
   * **Never `pendingPermissions[0]!`, and this is the reason.** That non-null
   * assertion is erased at runtime, so a regression in the code under test does
   * not fail a case — it throws `TypeError: Cannot read properties of undefined`
   * and takes the whole process down mid-run. Measured: commenting out
   * `this.pending.delete(permissionId)` in `registry.ts` printed ten `FAIL` lines
   * and then died, with no failure count and with **every later section of this
   * file — the permission-expired block and `/clear` — never executed at all**.
   *
   * In a repository where the drivers are the entire safety net, a broken
   * invariant has to produce a red line and a total, not a stack trace that
   * silently deletes the rest of the coverage.
   *
   * The fallback is a **real path segment** rather than `""`, and that took a
   * correction: an empty one leaves `/sessions/:id/permissions/` matching no
   * route at all, so Hono answers its own plain-text 404 and the JSON parse in
   * `answer` throws — reintroducing the crash one layer out. A token that cannot
   * be a minted id reaches the handler instead and is refused as one.
   */
  const NOTHING_PENDING = "no-pending-permission";
  const waitingOn = (): string => blocked.snapshot().pendingPermissions[0]?.permissionId ?? NOTHING_PENDING;

  const workdir = tmp("permcheck-");
  const blocked = await permRegistry.create({ agent: "kimi", cwd: workdir });
  const idle = await permRegistry.create({ agent: "kimi", cwd: workdir });
  // Pinned, so the ordering assertion below has something to beat: pinned is the
  // rank immediately under blocked, and every other row here is live.
  idle.setMeta({ pinned: true });

  blocked.prompt("do the thing");
  await quiesce();

  /* ---- the session is genuinely blocked ---- */

  check("a session waiting on the agent's question is blocked", blocked.status, "blocked");
  const pending = blocked.snapshot().pendingPermissions;
  check("and carries exactly one question", pending.length, 1);
  check("naming the tool call it belongs to", pending[0]?.toolCallId, "tc_1_9001");
  check("with the agent's own title", pending[0]?.title, "Terminal");
  check(
    "and every option it offered, in order",
    pending[0]?.options.map((option) => option.optionId),
    ["o_yes", "o_always", "o_no", "o_never"],
  );
  /*
   * Both of these ride the *snapshot*, which `GET /sessions` returns for every
   * session at once — so they are clamped an order tighter than a per-event cap.
   * Carrying them at all is the fix for the measured kimi case: its `tool_call`
   * arrives with `rawInput: null` and the command appears only as a text block
   * on the request, so a card joining against the log alone drew an approve
   * button above an empty box every single time.
   */
  check("the raw arguments come with it", (pending[0]?.rawInput as any)?.command, "rm -rf /");
  check("and so does the text block, which is where kimi puts the command", Array.isArray(pending[0]?.content), true);

  /*
   * Blocked outranks everything, which is what makes `?limit=` safe at all —
   * promised where `listRank` is asserted above and only provable here, because
   * a restored row cannot hold a pending permission.
   */
  const cut = await permApp.fetch(
    new Request("http://d/sessions?limit=1", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a cut of one keeps the blocked session, over a pinned one",
    ((await cut.json()) as any).sessions.map((s: { id: string }) => s.id),
    [blocked.id],
  );

  /* ---- the answer reaches the agent ---- */

  const permissionId = pending[0]?.permissionId ?? "";
  const ok = await answer(blocked.id, permissionId, { optionId: "o_always" });
  check("answering it is a 200", ok.status, 200);
  check("recorded, and not a repeat", [ok.body.recorded, ok.body.repeat], [true, false]);
  check("with the outcome and the option that was picked", [ok.body.outcome, ok.body.optionId], ["selected", "o_always"]);
  /*
   * "recorded", never "the agent continued": once the agent's connection is gone
   * the SDK swallows the send, so delivery cannot be proven from here. Only a
   * later event in the log proves effect — which is the next assertion.
   */
  check("and an honest word about delivery rather than a claim of effect", ok.body.delivered, "sent");

  await quiesce();
  /*
   * The one observable that proves the ordering inside `settle`: the agent was
   * handed the option a human chose. If the append ran first and threw, this
   * array would be empty while the route had already answered 200.
   */
  check("the agent really was unblocked, with the option a human picked", answered.length, 1);
  check("and it is the one they picked, not the agent's own preference", (answered[0]?.outcome as any)?.optionId, "o_always");
  check("the session stops being blocked", blocked.status, "idle");
  check("and its snapshot holds no question", blocked.snapshot().pendingPermissions.length, 0);

  /*
   * The registry appends this, not `session.ts` — `settle()` appends
   * *synchronously*, in the statement after the agent's own promise is resolved, so
   * routing it through the `EventQueue` would put a microtask between the two and a
   * client answering inside it could beat its own request into the log.
   */
  const resolvedEvents = blocked.log
    .read(0, 200, 1 << 20)
    .map((stored) => stored.event)
    .filter((event) => event.type === "permission_resolved");
  check("the resolution is in the log", resolvedEvents.length, 1);
  check("attributed to the client rather than to a sweep", (resolvedEvents[0] as any)?.by, "client");

  /* ---- answering twice ---- */

  /*
   * **A 409 carrying a success-shaped body**, and this is the daemon end of an
   * invariant only the client end was pinned on. `packages/web/src/http.ts`
   * reads `error.code`/`error.detail` and `webcheck` asserts it copes with this
   * shape — but nothing here asserted the daemon still *sends* it, so the two
   * could drift and a successful approval would start rendering as a failure
   * with raw JSON for a message.
   */
  const again = await answer(blocked.id, permissionId, { optionId: "o_yes" });
  check("answering the same one twice is a 409", again.status, 409);
  check("but the body says it landed, because it did", again.body.recorded, true);
  check("and says which time this was", again.body.repeat, true);
  check("carrying the outcome of the answer that won, not the one just sent", again.body.optionId, "o_always");
  check("with no error envelope at all, which is what a client keys on", "error" in again.body, false);
  check("and the agent was not told twice", answered.length, 1);

  /* ---- two clients answering at once ---- */

  /*
   * `pending.delete` is the compare-and-swap. Two answers run in separate
   * macrotasks with no await between the `get` and the `delete`, so exactly one
   * wins — and the loser must be told its answer did not decide anything rather
   * than being handed a second 200.
   */
  blocked.prompt("do another thing");
  await quiesce();
  const second = waitingOn();
  const [a, b] = await Promise.all([
    answer(blocked.id, second, { optionId: "o_yes" }),
    answer(blocked.id, second, { optionId: "o_no" }),
  ]);
  check(
    "two simultaneous answers settle it exactly once",
    [a.status, b.status].sort((x, y) => x - y),
    [200, 409],
  );
  check("the winner is not a repeat and the loser is", [a.body.repeat, b.body.repeat].sort(), [false, true]);
  await quiesce();
  check("and the agent heard one answer, not two", answered.length, 2);

  /* ---- what a body may say ---- */

  process.stdout.write("\nwhat an answer is allowed to say\n");

  blocked.prompt("do a third thing");
  await quiesce();
  const third = waitingOn();

  /*
   * Exactly one of the three forms, so an ambiguous body is never silently
   * resolved one way. Each of these leaves the permission pending, which is the
   * half worth having: a refused body must not settle anything.
   */
  const badBodies: Array<[string, unknown]> = [
    ["an empty body decides nothing", {}],
    ["two forms at once are ambiguous, not a preference", { optionId: "o_yes", cancel: true }],
    ["a decision and an option are too", { optionId: "o_yes", decision: "allow" }],
    ["a word that is not a decision is refused", { decision: "maybe" }],
    ["and cancel must be true rather than merely present", { cancel: false }],
    ["an option id that is not a string is not an option id", { optionId: 7 }],
  ];
  for (const [name, body] of badBodies) {
    const bad = await answer(blocked.id, third, body);
    check(name, [bad.status, bad.body.error?.code], [400, "bad_request"]);
  }
  check("and none of them settled it", blocked.snapshot().pendingPermissions.length, 1);

  {
    const wrong = await answer(blocked.id, third, { optionId: "o_nonexistent" });
    check("an option the agent never offered is refused", [wrong.status, wrong.body.error?.code], [400, "invalid_option"]);
    // The options come back with the refusal, so a client that is out of date can
    // redraw rather than guess.
    check(
      "and the refusal carries what was actually on offer",
      wrong.body.error?.detail?.options?.map((option: { optionId: string }) => option.optionId),
      ["o_yes", "o_always", "o_no", "o_never"],
    );
  }

  /*
   * A decision word is a *preference order* over kinds, not an id — which is
   * what lets one client vocabulary drive agents that name their options
   * differently. `allow` prefers `allow_once` and falls back to `allow_always`;
   * `reject_always` prefers `reject_always` and falls back to `reject_once`.
   */
  check("a decision word picks by kind, not by id", (await answer(blocked.id, third, { decision: "reject_always" })).body.optionId, "o_never");
  await quiesce();

  for (const [word, want] of [
    ["allow", "o_yes"],
    ["allow_always", "o_always"],
    ["reject", "o_no"],
  ] as const) {
    blocked.prompt(`do a ${word} thing`);
    await quiesce();
    const id = waitingOn();
    check(`"${word}" resolves to the option it prefers`, (await answer(blocked.id, id, { decision: word })).body.optionId, want);
    await quiesce();
  }

  {
    /*
     * The narrow offer: one `allow_once` and nothing else. It still parks —
     * `session.ts` forwards only when there is something a human could actually
     * pick — so a `reject` has a live permission to fail against rather than
     * falling through to the cancel path.
     */
    blocked.prompt("a narrow question");
    await quiesce();
    const narrow = waitingOn();
    const none = await answer(blocked.id, narrow, { decision: "reject" });
    check(
      "a decision with nothing of that kind on offer is refused",
      [none.status, none.body.error?.code],
      [400, "no_matching_option"],
    );
    check("and it is still waiting for an answer it can take", blocked.snapshot().pendingPermissions.length, 1);
    check("which cancel always is", (await answer(blocked.id, narrow, { cancel: true })).body.outcome, "cancelled");
    await quiesce();
  }

  check("an id nothing ever minted is a 404", (await answer(blocked.id, "not-a-permission", { cancel: true })).status, 404);
  check("and so is a session that does not exist", (await answer("s_nope", "perm-1-abc", { cancel: true })).status, 404);

  /*
   * The stand-in `waitingOn` answers with when nothing is pending, asserted
   * rather than merely tolerated: a regression that empties `pendingPermissions`
   * makes several cases above send it, and they have to fail on a 404 that says
   * so rather than on a crash inside the driver.
   */
  const standIn = await answer(blocked.id, NOTHING_PENDING, { cancel: true });
  check("and so is the stand-in a broken run would send", standIn.status, 404);
  check("answered by the handler in this daemon's own envelope", standIn.body?.error?.code, "permission_not_found");

  await permRegistry.shutdown();

  /* ---- and the two fields that used to have no bound at all ---- */

  {
    /*
     * ⚠ **`title` and `options` were passed through exactly as the agent sent
     * them**, while `rawInput` and `content` beside them were clamped at 8 KiB
     * each *because they ride the snapshot* — which these two do as well.
     * `truncateEvent` then declined to cut the event on the written ground that
     * permissions are "already clamped far tighter upstream by `clampBlob`":
     * true of the two fields that are not on the event, false of the two that
     * are. So the amplifier was the snapshot rather than the log — one huge
     * title re-sent on every four-second `GET /sessions`, for every session on
     * the machine, over the relay, to a phone.
     *
     * Driven through the wire rather than asserted against `clip`, because what
     * was missing was a call site and every pure function involved was correct.
     *
     * ⚠ **This block used to assert a *clip* at 200 characters, and now asserts a
     * refusal at 8 KiB over the pair.** Two things forced the change. A clipped
     * `option.name` is a model-written *answer* whenever kimi asks a question down
     * this channel, and `askedQuestion` recovers the question by matching that name
     * against the same string in `rawInput` **by identity** — `rawInput` is bounded
     * by bytes and never by characters, so past 200 the two disagreed and the whole
     * question silently fell back to a row of buttons. And a person must never be
     * shown a shortened version of what an agent asked. What the snapshot needed
     * was never a per-string cap; it was one number over the thing that rides it.
     */
    const shouted = await permRegistry.create({ agent: "kimi", cwd: workdir });
    shouted.prompt("run it, shouting");
    await quiesce();
    check("a 50 KB title is refused rather than parked", shouted.snapshot().pendingPermissions.length, 0);
    // The same property the swarming case below asserts, and for the same reason:
    // the agent is told, the turn carries on, and nobody is left blocked on a card
    // this daemon declined to carry.
    check("so the session is not left blocked on it either", shouted.status === "blocked", false);
    await permRegistry.stop(shouted.id);

    /*
     * The other side of the same number, and it is the side that matters daily: a
     * title and an option name far longer than anything measured — 480 and 350
     * characters against a live-log maximum of 14 and 31 — arrive **whole**. Both
     * would have been cut by the 200 that used to be here.
     */
    const wordy = await permRegistry.create({ agent: "kimi", cwd: workdir });
    wordy.prompt("run it, wordy");
    await quiesce();
    const carried = wordy.snapshot().pendingPermissions[0];
    check("a long title and a long option name are still asked", wordy.status, "blocked");
    report(
      "and the snapshot carries both of them whole",
      (carried?.title.length ?? 0) > 400 && (carried?.options[0]?.name.length ?? 0) > 300,
      `title ${carried?.title.length ?? -1}, option ${carried?.options[0]?.name.length ?? -1}`,
    );
    report(
      "with no truncation marker anywhere in the pair",
      !/\u2026\[truncated \d+ bytes\]/.test(`${carried?.title ?? ""}${carried?.options[0]?.name ?? ""}`),
      "read off the snapshot the relay would send",
    );
    await permRegistry.stop(wordy.id);

    /*
     * ⚠ **The same bound, spelled in a script where a character is not a byte.**
     * The refusal above is `MAX_PERMISSION_SNAPSHOT_BYTES` and it was measured with
     * `jsonSize`, which is `JSON.stringify(...).length` — UTF-16 code units. Every
     * BMP character above U+07FF is one unit and three bytes, so a title of 8,000
     * CJK characters weighed 8,002 against a limit of 8,192, passed, and put 24,002
     * bytes on the wire. Three times the number the sentence quotes, on the pair
     * that rides `GET /sessions` for every session on the machine, on every poll,
     * through the relay, to a phone — which is the amplifier this whole block
     * exists for, reached in the one alphabet nobody had measured.
     *
     * Driven through the wire for the reason written above: the arithmetic was
     * never wrong, the unit was, and a pure-function assertion would have agreed
     * with it.
     */
    const cjk = await permRegistry.create({ agent: "kimi", cwd: workdir });
    cjk.prompt("run it, in Chinese");
    await quiesce();
    check("a title that is 8 KiB of characters and 24 KiB of bytes is refused too", cjk.snapshot().pendingPermissions.length, 0);
    check("and that session is not left blocked on it either", cjk.status === "blocked", false);
    await permRegistry.stop(cjk.id);
  }

  {
    /*
     * **Refused whole rather than trimmed**, and this is the one arm where that
     * is the only honest answer: an `optionId` round-trips verbatim in the
     * response, so a clipped one is an answer the agent will not recognise, and
     * dropping options removes choices it offered — which the client stopped doing
     * in this release, `permissionLayout` giving up a *layout* instead.
     *
     * What has to be true is that the session does not end up *blocked* on a
     * card nobody bounded: the agent is told, and the turn carries on.
     */
    const swarmed = await permRegistry.create({ agent: "kimi", cwd: workdir });
    swarmed.prompt("run it, swarming");
    await quiesce();
    check("200 options is refused rather than parked", swarmed.snapshot().pendingPermissions.length, 0);
    check("so the session is not left blocked on it", swarmed.status === "blocked", false);
    await permRegistry.stop(swarmed.id);
  }
}

/*
 * An id this daemon really did mint, for a life that is over.
 *
 * `resolved` is in memory and `askSeq`/`askSalt` are on the row,
 * so a restart is exactly the state where an id is recognisably ours and no
 * longer answerable. That asymmetry is the whole of `looksLikeOurs`, and the
 * rule it exists for is one line in `registry.ts`: **"too old to report" must
 * never come back as "never existed"** — a client holding a permission id from
 * before a deploy is owed a 409 saying it was settled and forgotten, not a 404
 * telling it the daemon never heard of a request it can see in its own
 * transcript.
 *
 * Driven off a restored row with no agent anywhere, which is the only way to
 * reach it: nothing in a live session can empty `resolved` while keeping the
 * counter.
 */
/* ------------------------------------------------------------------ *
 * Answering a question the agent is waiting on
 * ------------------------------------------------------------------ */

/**
 * The elicitation half of the permission block above, against an agent that
 * really is waiting.
 *
 * Same shape and the same reason: the settle order is only observable through its
 * one consequence — the agent is handed the content a person actually typed — and
 * an agent that answers its own prompt immediately would assert nothing.
 *
 * What this pins that the permission block cannot: that `status === "blocked"`
 * and `listRank` read *both* maps. A session holding only a question is the one
 * state where deleting the `pendingElicitations` term from `awaitingCount` fails
 * a case and nothing else does.
 */
process.stdout.write("\nanswering a question the agent is waiting on\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** What the client sent back, in the agent's own words. */
  const answered: { action?: string; content?: Record<string, unknown> }[] = [];

  const spawnAgent = (): AgentProcess => {
    const sessionId = "s_ask_1";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    let heldPromptId: unknown = null;
    let askId = 7000;

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // The answer to the question this agent asked; the turn was waiting on it.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "end_turn" } });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.prompt: {
            heldPromptId = id;
            askId += 1;
            // The measured AskUserQuestion shape: a titled single-select and the
            // adapter's own free-text box beside it.
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.elicitation.create,
              params: {
                mode: "form",
                sessionId,
                toolCallId: `tc_ask_${askId}`,
                message: "Which framework should I use?",
                requestedSchema: {
                  type: "object",
                  required: ["question_0"],
                  properties: {
                    question_0: {
                      type: "string",
                      title: "Framework",
                      oneOf: [
                        { const: "React", title: "React", description: "Already in package.json" },
                        { const: "Svelte", title: "Svelte" },
                      ],
                    },
                    question_0_custom: { type: "string", title: "Other", maxLength: 80 },
                  },
                },
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class AskRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const askRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new AskRuntime());
  const { app: askApp } = createApp({
    registry: askRegistry,
    verifier,
    instanceId: "i_ask",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  /**
   * Guarded for the reason `waitingOn` is guarded one block up: an erased
   * non-null assertion turns a regression into a `TypeError` that kills the run
   * and silently deletes every later section's coverage. The stand-in is a real
   * path segment so Hono still matches the route and the handler refuses it.
   */
  const NOTHING_PENDING = "no-pending-elicitation";
  const askingOn = (): string =>
    asked.snapshot().pendingElicitations[0]?.elicitationId ?? NOTHING_PENDING;

  /** Answering over HTTP, with a parse that cannot throw. */
  const reply = async (elicitationId: string, body: unknown): Promise<{ status: number; body: any }> => {
    const response = await askApp.fetch(
      new Request(`http://d/sessions/${asked.id}/elicitations/${elicitationId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };

  const workdir = tmp("askcheck-");
  const asked = await askRegistry.create({ agent: "kimi", cwd: workdir });
  const idle = await askRegistry.create({ agent: "kimi", cwd: workdir });
  idle.setMeta({ pinned: true });

  asked.prompt("pick one");
  await quiesce();

  /* ---- blocked on a question, with no permission anywhere ---- */

  check("a session waiting on a question is blocked", asked.status, "blocked");
  // The case that pins `awaitingCount`. Deleting the `pendingElicitations` term
  // from it fails this and nothing else in the file.
  check("with no permission outstanding at all", asked.snapshot().pendingPermissions.length, 0);
  const waiting = asked.snapshot().pendingElicitations;
  check("and exactly one question", waiting.length, 1);
  check("naming the tool call it belongs to", waiting[0]?.toolCallId, "tc_ask_7001");
  check("carrying the agent's prompt", waiting[0]?.message, "Which framework should I use?");
  // The form is deliberately *not* on the snapshot — a question cannot be
  // answered from a list, so only enough to say one is waiting rides the poll.
  check("and only a field count, not the form", waiting[0]?.fieldCount, 2);
  check(
    "the two derivations of 'somebody is waiting' agree",
    awaitingHuman(asked.snapshot()),
    asked.status === "blocked",
  );

  const cut = await askApp.fetch(
    new Request("http://d/sessions?limit=1", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a cut of one keeps the session with a question, over a pinned one",
    ((await cut.json()) as any).sessions?.[0]?.id,
    asked.id,
  );

  /* ---- the form is fetched, not polled ---- */

  const formResponse = await askApp.fetch(
    new Request(`http://d/sessions/${asked.id}/elicitations/${askingOn()}`, {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  const form = (await formResponse.json()) as any;
  check("the form comes from its own route", formResponse.status, 200);
  check(
    "with the fields in the order the agent declared them",
    form.fields?.map((field: any) => [field.key, field.kind, field.required]),
    [
      ["question_0", "string", true],
      ["question_0_custom", "string", false],
    ],
  );
  check("and each option's label", form.fields?.[0]?.options?.map((o: any) => o.label), ["React", "Svelte"]);

  /* ---- what an answer is allowed to say ---- */

  const badBodies: [string, unknown, string][] = [
    ["an empty body names no form", {}, "bad_request"],
    ["two forms at once are never resolved one way", { content: {}, cancel: true }, "bad_request"],
    ["nor are the other two", { decline: true, cancel: true }, "bad_request"],
    ["a false flag is not a form", { cancel: false }, "bad_request"],
    ["null content is not an object", { content: null }, "bad_request"],
    ["an array is not an object either", { content: [] }, "bad_request"],
    ["a key the form never had is refused, never stripped", { content: { nope: "x" } }, "invalid_content"],
    ["a required field left out is refused", { content: { question_0_custom: "x" } }, "invalid_content"],
    ["a number for a string is not coerced", { content: { question_0: 7 } }, "invalid_content"],
    ["a value the form never offered is refused", { content: { question_0: "Vue" } }, "invalid_content"],
    [
      "and one over a field's own maxLength",
      { content: { question_0: "React", question_0_custom: "y".repeat(200) } },
      "invalid_content",
    ],
  ];
  for (const [label, body, code] of badBodies) {
    const result = await reply(askingOn(), body);
    check(label, [result.status, result.body?.error?.code], [400, code]);
  }
  // The half worth having: none of them settled it.
  check("and none of them settled it", asked.status, "blocked");
  check("nor was the agent told anything", answered.length, 0);

  /* ---- the answer lands, and the agent hears it ---- */

  const settledId = askingOn();
  const ok = await reply(settledId, { content: { question_0: "React" } });
  check("a valid answer is recorded", [ok.status, ok.body?.recorded, ok.body?.action], [200, true, "accept"]);
  await quiesce();

  /*
   * The one observable that pins `settleElicitation`'s statement order: the agent
   * was unblocked with the content a person typed, before anything was logged.
   */
  check("and the agent really was handed it", answered[0]?.content, { question_0: "React" });
  check("the session is no longer blocked", asked.status, "idle");
  check("and holds no question", asked.snapshot().pendingElicitations.length, 0);

  /*
   * The resolution renders with no join back to the request.
   *
   * This is the `permissionDecisions` lesson pinned rather than repeated: a
   * `permission_resolved` carries only an `optionId`, so a refused command was
   * once drawn with a check mark. `value` is the option's **label** — what the
   * person read and tapped — and never its wire value.
   */
  const log = asked.log.read(0, 1000, 1024 * 1024).map((stored) => stored.event);
  const resolved = log.find((event) => event.type === "elicitation_resolved");
  check("the log records the answer", resolved?.type, "elicitation_resolved");
  check(
    "already rendered, so a transcript needs no join",
    resolved?.type === "elicitation_resolved" ? resolved.answers : null,
    [{ key: "question_0", label: "Framework", value: "React" }],
  );
  check(
    "and says a human did it",
    resolved?.type === "elicitation_resolved" ? resolved.by : null,
    "client",
  );

  /* ---- answering twice ---- */

  const again = await reply(settledId, { content: { question_0: "Svelte" } });
  check(
    "answering again is a 409 carrying a success-shaped body",
    [again.status, again.body?.recorded, again.body?.repeat],
    [409, true, true],
  );
  // The action that *won*, not the one just sent.
  check("naming the answer that won", again.body?.action, "accept");
  check("and it is not an error envelope", again.body?.error, undefined);

  /* ---- decline and cancel are distinct on the wire ---- */

  asked.prompt("pick again");
  await quiesce();
  await reply(askingOn(), { decline: true });
  await quiesce();
  check("declining reaches the agent as a decline, so its turn carries on", answered[1]?.action, "decline");

  asked.prompt("once more");
  await quiesce();
  await reply(askingOn(), { cancel: true });
  await quiesce();
  check("and cancelling as a cancel, which aborts the tool call", answered[2]?.action, "cancel");

  /* ---- the sweep ---- */

  asked.prompt("and again");
  await quiesce();
  check("a question is outstanding before the stop", asked.snapshot().pendingElicitations.length, 1);
  await asked.stop();
  check("stopping sweeps it rather than leaving the agent parked", asked.snapshot().pendingElicitations.length, 0);
  const swept = asked.log
    .read(0, 1000, 1024 * 1024)
    .map((stored) => stored.event)
    .filter((event) => event.type === "elicitation_resolved")
    .at(-1);
  check(
    "and says who settled it",
    swept?.type === "elicitation_resolved" ? [swept.action, swept.by] : null,
    ["cancel", "session_stopped"],
  );

  await askRegistry.shutdown();
}

/* ------------------------------------------------------------------ *
 * Stopping the turn without stopping the session
 * ------------------------------------------------------------------ */

/**
 * `POST /sessions/:id/cancel`, against agents that behave three different ways.
 *
 * **The stub carries an explicit `session/cancel` arm, and that is the point of
 * the whole block.** It is a *notification* — no `id` — so without an arm it
 * lands in the `default:` case, where `if (id !== undefined)` discards it in
 * silence. Every assertion below would then pass just as well against a daemon
 * that never sent the notification at all, which is the one failure a driver for
 * this feature exists to catch. `cancelsSeen` is asserted before anything else.
 *
 * Three behaviours, because the interesting cases are the ones where the agent
 * does not simply comply:
 *
 *   "ask me"       parks a permission and answers `cancelled` only once the
 *                  client has settled it — which is ACP's actual contract and
 *                  the reason the daemon sweeps *after* sending. An agent
 *                  blocked on a human cannot see a cancel until it is answered,
 *                  so a daemon that waited before sweeping would hang here.
 *   "work quietly" answers `cancelled` as soon as it is asked. The ordinary case.
 *   "ignore me"    never answers at all, which is legal: cancellation is a
 *                  notification and nothing obliges an agent to act on it. This
 *                  is what proves `settled: false` is reachable and honest.
 */
process.stdout.write("\nstopping the turn without stopping the session\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** Every `session/cancel` this daemon sent, by the session id it named. */
  const cancelsSeen: string[] = [];
  /** What the client answered the parked permission with, in the agent's words. */
  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  const spawnAgent = (): AgentProcess => {
    const sessionId = "s_cancel_1";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    let heldPromptId: unknown = null;
    /** Whether this turn was asked to stop, so the stop reason can be honest. */
    let cancelled = false;
    /** The one behaviour that answers nothing, ever. See the block's docblock. */
    let stubborn = false;
    /** Set by a prompt that asks, so the cancel arm knows not to self-answer. */
    let pendingAsk: string | null = null;
    let askId = 5000;

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // The client's answer to the permission this agent parked. A real agent
        // only reaches its own turn end here, which is why the daemon has to send
        // one after cancelling rather than wait for the turn to notice.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({
              jsonrpc: "2.0",
              id: heldPromptId,
              result: { stopReason: cancelled ? "cancelled" : "end_turn" },
            });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.cancel: {
            cancelsSeen.push(message["params"]?.["sessionId"]);
            cancelled = true;
            // Nothing is parked, so this agent is free to end its own turn — the
            // path an agent that is merely thinking takes. The stubborn one does
            // not, and neither does one waiting on a permission: that one answers
            // above, when the client finally settles it.
            if (heldPromptId !== null && !stubborn && pendingAsk === null) {
              send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "cancelled" } });
              heldPromptId = null;
            }
            break;
          }
          case acp.methods.agent.session.prompt: {
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            /*
             * A **rejected** prompt, which is the shape a provider failure takes
             * and is not a shape any other arm here produces. Measured from the
             * live log: `-32603` carrying the upstream's own prose and **no**
             * `errorKind` — which is why `isAuthFailure` correctly ignores it and
             * why matching the text was never an option.
             */
            if (text.includes("fail me")) {
              send({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message:
                    "Internal error: [Anthropic] 'claude-opus-4-7' does not support the `speed` parameter.",
                },
              });
              heldPromptId = null;
              break;
            }
            cancelled = false;
            stubborn = text.includes("ignore me");
            heldPromptId = id;
            if (!text.includes("ask me")) {
              pendingAsk = null;
              break;
            }
            askId += 1;
            pendingAsk = `tc_cancel_${askId}`;
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.session.requestPermission,
              params: {
                sessionId,
                toolCall: {
                  toolCallId: pendingAsk,
                  title: "Terminal",
                  rawInput: { command: "sleep 600" },
                },
                options: [
                  { optionId: "o_yes", name: "Yes", kind: "allow_once" },
                  { optionId: "o_no", name: "No", kind: "reject_once" },
                ],
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class CancelRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const cancelRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new CancelRuntime());
  const { app: cancelApp } = createApp({
    registry: cancelRegistry,
    verifier,
    instanceId: "i_cancel",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const postCancel = async (sessionId: string): Promise<{ status: number; body: any }> => {
    const response = await cancelApp.fetch(
      new Request(`http://d/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
  };

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  const workdir = tmp("cancelcheck-");
  const live = await cancelRegistry.create({ agent: "kimi", cwd: workdir });
  const eventsOf = (type: string) =>
    live.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === type);

  /* ---- nothing is running ---- */

  /*
   * A 200 and not a 409, which is the one shape in this route worth arguing
   * about. Nothing was stopped and nothing is wrong: the caller asked for an
   * agent that is not working and it is not working. That state is also what an
   * ordinary lost race looks like — the tap and the turn's own end are not
   * ordered by anything — so a red error here would make the control look broken
   * at the exact moment it got what it wanted.
   */
  const idleAnswer = await postCancel(live.id);
  check("cancelling with nothing in flight is a 200", idleAnswer.status, 200);
  check("saying plainly that nothing was cancelled", [idleAnswer.body.cancelled, idleAnswer.body.turn], [false, null]);
  check("and that there is nothing left to wait for", idleAnswer.body.settled, true);
  check("with no notification sent to the agent at all", cancelsSeen.length, 0);

  /* ---- an agent that is simply working ---- */

  live.prompt("work quietly");
  await quiesce();
  check("a turn is in flight", live.status, "running");

  const quiet = await postCancel(live.id);
  check("cancelling it is a 200", quiet.status, 200);
  check("naming the turn it stopped", [quiet.body.cancelled, quiet.body.turn], [true, 1]);
  check("and reporting that the agent really finished", quiet.body.settled, true);
  /*
   * The assertion the stub's `session/cancel` arm exists for. Without it every
   * case in this block passes against a daemon that sends nothing, because a
   * notification with no `id` is discarded in silence by the `default:` arm.
   */
  check("the notification reached the agent", cancelsSeen, ["s_cancel_1"]);
  check("naming the agent's own session id, never ours", cancelsSeen[0] !== live.id, true);

  await quiesce();
  check("the session is idle again rather than ended", live.status, "idle");
  check("with no exit recorded — this is not a stop", live.snapshot().exit, null);
  check(
    "the turn ended as cancelled, which the transcript draws",
    eventsOf("turn_end").map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["cancelled"],
  );
  check("and the marker is cleared with the turn", live.snapshot().cancelRequestedAt, null);

  /* ---- an agent blocked on a human ---- */

  /*
   * The ordering case, and the reason `cancelTurn` sweeps *after* it sends rather
   * than before or instead. This agent answers its prompt only once the client
   * settles the permission — which is ACP's contract, not a quirk of the stub —
   * so a daemon that sent the notification and then waited would spend its whole
   * budget and report `settled: false`, and one that never swept would leave the
   * session `blocked` for ever on a turn nobody can end.
   */
  live.prompt("ask me first");
  await quiesce();
  check("a session parked on a permission is blocked", live.status, "blocked");

  const parked = await postCancel(live.id);
  check("cancelling it is still a 200", parked.status, 200);
  check("and the turn really did settle, because the sweep unblocked it", parked.body.settled, true);
  check("the agent was answered rather than left holding the promise", answered.length, 1);
  check("and it was answered with a cancellation", answered[0]?.outcome?.outcome, "cancelled");
  check("nothing is parked any more", live.snapshot().pendingPermissions.length, 0);
  check("the session is idle, not blocked and not ended", live.status, "idle");

  /*
   * **The assertion that makes the ordering claim true**, and without it the
   * whole block above passes for a daemon that sweeps first.
   *
   * Everything asserted so far is satisfied by either order: `outcome:
   * "cancelled"` is this daemon's own constant, so it says what *we* sent and
   * nothing about what the agent heard, and the session goes idle either way.
   * The stop reason is the agent's word — this stub answers `cancelled` only if
   * `session/cancel` arrived before the answer that freed its turn, and
   * `end_turn` otherwise, which is exactly what a real agent does. Measured by
   * putting one yield between the send and the sweep: the wire order becomes
   * answer → `turn_end{end_turn}` → cancel, and this line is the only one in the
   * file that goes red.
   */
  check(
    "and this turn ended as cancelled too, which only send-then-sweep achieves",
    eventsOf("turn_end").map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["cancelled", "cancelled"],
  );

  const sweptBy = eventsOf("permission_resolved").at(-1);
  /*
   * Its own reason and not `session_stopped`, which is the nearest existing
   * member and says the opposite of what happened: that one means the session is
   * over, and this session is idle and still holding its conversation.
   */
  check(
    "attributed to the cancel rather than to a stop or a turn that ended",
    sweptBy?.type === "permission_resolved" ? sweptBy.by : null,
    "turn_cancelled",
  );

  /* ---- a turn that ends in an error ---- */

  /*
   * ⭐ **Four prompts, three `turn_end`s** — found in a live log, not here, because
   * nothing here asked. `Session.prompt` turns a rejected `session/prompt` into an
   * `error` event and returns on it exactly as it returns on a `turn_end`, so the
   * turn was over and nothing marked the boundary. Q2.103 had already made the
   * argument for the cancel path in the same file: the daemon writes the end
   * itself because the agent never gets to, and a prompt with no turn end at all
   * is the shape this codebase calls a message that reached no model.
   */
  const endsBefore = eventsOf("turn_end").length;
  live.prompt("fail me");
  await quiesce();
  check("a turn the agent rejected is over rather than running", live.status, "idle");
  check(
    "the agent's own error, and then an end — in that order",
    live.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event.type)
      .slice(-2),
    ["error", "turn_end"],
  );
  /*
   * `agent_error` and not one of ACP's five: `refusal` is the *model* declining
   * and `cancelled` is something a person did, and either would be a lie in the
   * one row a reader trusts about what happened. The client draws no row for it —
   * the error above it is the same fact in the agent's own words — but it still
   * cuts `Tail.taskFloor`, which is what stops a turn that failed mid-delegation
   * counting its pending calls for ever.
   */
  check(
    "carrying the reason ACP has no word for, because ACP never got that far",
    eventsOf("turn_end")
      .slice(endsBefore)
      .map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["agent_error"],
  );
  check("exactly one end for one prompt, which is the whole property", eventsOf("turn_end").length - endsBefore, 1);
  /*
   * And the agent is **not** replaced. `failed` means `session.prompt()` rejected
   * — the message was never taken — and a provider error arrives *through* the
   * generator, so `onAgentUnusable` must not fire on an ordinary bad turn. The
   * proof is the next block: it prompts this same session and gets a turn.
   */
  check("with no exit recorded, because a bad turn is not a dead agent", live.snapshot().exit, null);

  /* ---- an agent that ignores it ---- */

  /*
   * Legal, and the honest half of this feature: `session/cancel` is a
   * notification with no response, so nothing here can make an agent stop. What
   * the daemon promises is that it asked — and `settled: false` is how it says
   * the agent had not finished by the time anybody stopped watching.
   */
  live.prompt("ignore me");
  await quiesce();
  const ignored = await postCancel(live.id);
  check("cancelling an agent that will not stop is still a 200", ignored.status, 200);
  check("the daemon says it asked", ignored.body.cancelled, true);
  check("and says honestly that the agent has not finished", ignored.body.settled, false);
  check("the turn is still in flight, so the session still reads running", live.status, "running");
  /*
   * The field the composer's Stop button is drawn from. It has to survive an
   * unsettled cancel — that is the entire state it exists for — or the control
   * springs back to armed and invites the second tap that does nothing.
   */
  check("and the snapshot still says somebody asked", typeof live.snapshot().cancelRequestedAt, "number");

  // Not memoised, unlike `stop()`: asking twice is a person tapping again, and
  // the honest answer is to ask the agent again rather than replay the first.
  const twice = await postCancel(live.id);
  check("asking twice is allowed rather than deduplicated", twice.body.cancelled, true);
  check("and really did send a second notification for this turn", cancelsSeen.length, 4);

  /* ---- a session that has ended ---- */

  await live.stop();
  const dead = await postCancel(live.id);
  check("cancelling a session that has ended is a 409", dead.status, 409);
  check("saying which, so a client can offer resume rather than retry", dead.body.error?.code, "session_terminal");
  check("and a session id nothing minted is still a 404", (await postCancel("s_nope")).status, 404);

  await cancelRegistry.shutdown();
}

process.stdout.write("\na permission id from a life that has ended\n");
{
  const restored: PersistedSession = {
    ...rowFor("s_perm_old", join(users, "u_alice", "perms")),
    askSeq: 3,
    askSalt: "abc",
  };
  const oldRegistry = new SessionRegistry(new MemoryEventStore(), storeOf([restored]));
  oldRegistry.restore({ reapOrphans: false });
  const { app: oldApp } = createApp({
    registry: oldRegistry,
    verifier,
    instanceId: "i_perm_old",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const ask = (permissionId: string) => answerPermission(oldApp, "s_perm_old", permissionId, { cancel: true });

  const settled = await ask("perm-2-abc");
  check("an id this daemon minted before the restart is a 409", settled.status, 409);
  check("saying it was settled and forgotten, not that it never existed", settled.body.error.code, "permission_expired");

  /*
   * The two halves of the pattern, each of which alone would make the 409 a
   * blanket answer: a sequence above anything ever minted, and a salt from
   * somebody else's daemon.
   */
  check("a sequence this daemon never reached is a 404", (await ask("perm-9-abc")).status, 404);
  check("and another daemon's salt is too, however well formed", (await ask("perm-2-def")).status, 404);
  check("as is something that is not an id at all", (await ask("perm-x-abc")).status, 404);
  check("the boundary is inclusive: the last id it minted is still recognised", (await ask("perm-3-abc")).status, 409);

  /*
   * The same rule, through the same `looksLikeOurs`, for the other kind of
   * question — and the case that proves one counter serves two prefixes without
   * either answering for the other.
   *
   * A shared counter is what let an elicitation id survive a restart with no
   * second persisted column, and therefore with no `migrate()` and no
   * `SCHEMA_VERSION` argument. The cost is gaps in each kind's numbering, which
   * nothing reads as a count; what must *not* happen is a `perm-` id being
   * recognised as an `elic-` one or the reverse.
   */
  const askElic = async (elicitationId: string): Promise<{ status: number; body: any }> => {
    const response = await oldApp.fetch(
      new Request(`http://d/sessions/s_perm_old/elicitations/${elicitationId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ cancel: true }),
      }),
    );
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };

  const oldQuestion = await askElic("elic-2-abc");
  check("a question id from before the restart is a 409 too", oldQuestion.status, 409);
  check("with its own code", oldQuestion.body.error.code, "elicitation_expired");
  check("a sequence never reached is a 404", (await askElic("elic-9-abc")).status, 404);
  check("another daemon's salt likewise", (await askElic("elic-2-def")).status, 404);
  check("and the boundary is inclusive here as well", (await askElic("elic-3-abc")).status, 409);
  // One counter, two prefixes: neither route answers for the other's ids.
  check("a permission id is not a question", (await askElic("perm-2-abc")).status, 404);
  check("and a question id is not a permission", (await ask("elic-2-abc")).status, 404);

  await oldRegistry.shutdown();
}

/*
 * `/clear` is carried out by the daemon, not forwarded.
 *
 * Measured 2026-08-05: forwarding it makes claude's CLI fork *underneath* ACP —
 * our session id does not move, the file it names keeps the pre-clear history,
 * and the live conversation gets an id nobody tells us. The next boot's resume
 * then reattached to the abandoned one and handed back a codeword somebody had
 * cleared. Opening the session ourselves removes the cause, and the assertion
 * that matters is that the recorded id is the one *we* were given.
 */
process.stdout.write("\ncarrying out a clear\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");

  let opened = 0;
  const closed: string[] = [];
  const prompts: string[] = [];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);

  let buffer = "";
  toAgent.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message["id"];
      const params = (message["params"] ?? {}) as Record<string, any>;
      switch (message["method"]) {
        case acp.methods.agent.initialize:
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: acp.PROTOCOL_VERSION,
              // `close` advertised, so the old session really is closed rather
              // than leaked — one per clear, inside a long-lived agent process.
              agentCapabilities: { sessionCapabilities: { close: {} } },
              authMethods: [],
            },
          });
          break;
        case acp.methods.agent.session.new:
          opened += 1;
          send({ jsonrpc: "2.0", id, result: { sessionId: `conv_${opened}` } });
          break;
        case acp.methods.agent.session.close:
          closed.push(String(params["sessionId"]));
          send({ jsonrpc: "2.0", id, result: {} });
          break;
        case acp.methods.agent.session.prompt:
          prompts.push(`${String(params["sessionId"])}:${String(params["prompt"]?.[0]?.text ?? "")}`);
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          break;
        default:
          if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  class ClearRuntime extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      } as unknown as AgentProcess;
    }
  }

  const session = await Session.start({
    agent: "claude",
    cwd: process.cwd(),
    runtime: new ClearRuntime(),
  });
  check("a session starts on the agent's first conversation", session.sessionId, "conv_1");

  const moved = await session.clearContext();
  check("a clear opens a second one", [moved.previous, moved.next], ["conv_1", "conv_2"]);
  // The whole point: the id is one we were *given*, not one we noticed later.
  check("and the session is now on it", session.sessionId, "conv_2");
  check("the old conversation is closed rather than leaked", closed, ["conv_1"]);
  /*
   * Nothing was sent to the agent as text. Forwarding `/clear` is what produced
   * the fork we could not see; if this ever regresses to a passthrough, the
   * daemon and the agent go back to disagreeing about which conversation is
   * live, silently.
   */
  check("and `/clear` was never forwarded as a prompt", prompts, []);

  /*
   * And the next turn goes to the new conversation, which is the observable end
   * of the same fact: the session is addressing `conv_2`, so a resume that
   * stores this id lands where the agent actually is.
   */
  for await (const _event of session.prompt("hello")) {
    // Drained rather than ignored: the generator is what runs the turn.
  }
  check("the next prompt goes to the new conversation", prompts, ["conv_2:hello"]);

  await session.dispose();
}

/* ------------------------------------------------------------------ *
 * A clear is a turn as far as everything else is concerned
 *
 * `clearContext` re-keys the ACP session underneath the daemon — `session/new`,
 * then `session/close` on the old id, measured at ~600ms and bounded at 15s —
 * and for that whole window `this.turn` was `null`. So a prompt arriving beside
 * a `/clear` passed every guard and was issued against the conversation about to
 * be closed: its updates went to `router.sessions.get(<the old id>)`, which is
 * `undefined` and drops them silently, and the turn died with the `session/close`
 * — a message written into the transcript that reached no model and produced no
 * reply. A second `/clear` in the same window is the same hole with a worse
 * ending: both capture the same `previous`, both close it, and the conversation
 * the first one opened is left live inside the agent with nothing left to close
 * it.
 *
 * The marker is a second field beside `turn` rather than a reuse of it, because a
 * clear is not a turn: it burns no turn number and produces no `turn_end`. What
 * it shares is the only thing it is read for.
 *
 * **This is a second agent rig for a subject the section above already has one
 * for, and the split is the point.** That one drives `Session` directly through a
 * single shared pipe pair, which is exactly right for "what does a clear do to
 * the agent" and cannot answer this: what is under test here is
 * `ManagedSession`'s guard and the route's 409, so it needs a registry, an app,
 * and — above all — a `session/new` that does **not** answer immediately, because
 * the window this defect lived in is the one where the agent has not replied yet.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat else may talk to the agent during a clear\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** How long the *next* `session/new` takes to answer. The window, in one number. */
  let newDelayMs = 0;
  let conversations = 0;
  const closed: string[] = [];

  const spawnClearing = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                // Advertised so the old conversation is really closed, which is
                // the second half of the re-key and the slower one.
                agentCapabilities: { sessionCapabilities: { close: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new: {
            conversations += 1;
            const sessionId = `conv_${conversations}`;
            const answer = (): void => send({ jsonrpc: "2.0", id, result: { sessionId } });
            if (newDelayMs > 0) setTimeout(answer, newDelayMs);
            else answer();
            break;
          }
          case acp.methods.agent.session.close:
            closed.push(String(params["sessionId"]));
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class ClearingRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnClearing();
    }
  }

  const clearRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new ClearingRuntime());
  const { app: clearApp } = createApp({
    registry: clearRegistry,
    verifier,
    instanceId: "i_clearwindow",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const workdir = tmp("clearcheck-");
  const managed = await clearRegistry.create({ agent: "kimi", cwd: workdir });
  check("the session starts on the agent's first conversation", managed.agentSessionId, "conv_1");

  const sendText = async (text: string): Promise<{ status: number; body: any }> => {
    const response = await clearApp.fetch(
      new Request(`http://d/sessions/${managed.id}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : null };
  };

  // Wide enough that everything below runs inside it, and short enough that this
  // section costs a fifth of a second.
  newDelayMs = 200;
  const clearing = managed.clearContext("/clear");
  /*
   * Everything from here to the `await` runs while the agent's session id is
   * being replaced. The marker is set *before* `clearContext`'s own first await,
   * so it is already true by the time the call above has returned its promise —
   * which is the only reason a synchronous `prompt()` can see it at all.
   */
  check("a prompt beside an in-flight clear is refused", managed.prompt("hello").kind, "busy");
  check("and a second clear is refused the same way", (await managed.clearContext("/clear")).kind, "busy");
  /*
   * And through the route, which is where a client meets it: the same `409
   * turn_in_flight` a mid-turn message gets. The `status` beside it still reads
   * `idle`, deliberately — the marker is not a turn, it burns no turn number, and
   * putting a "working" timer on the snapshot for something the agent is not
   * thinking about would be the wrong lie. Pinned because it looks like a bug.
   */
  const refused = await sendText("hello over http");
  check("over HTTP it is the 409 a mid-turn message gets", [refused.status, refused.body?.error?.code], [409, "turn_in_flight"]);
  check("with a status that still says idle, because a clear is not a turn", refused.body?.error?.detail?.status, "idle");

  /*
   * **And the other two ways to talk to the agent, which the marker's own
   * docblock claimed and the code did not do.**
   *
   * `setConfigOption` and `setMode` reach `Session`, which reads `this.sessionId`
   * at request time — the id `clearContext` is in the middle of replacing. So a
   * mode tap inside this window either addresses the conversation `session/close`
   * is about to destroy, or lands during `restoreConfig`, which is putting back a
   * `wanted` snapshot captured *before* the tap and therefore silently reverts it.
   * Neither shows up anywhere: both answer `{kind: "ok"}` with a snapshot that
   * looks right. `AgentConfigBar` sits beside the composer, so `/clear` then a
   * mode change is one gesture apart.
   *
   * The refusal is `busy` rather than `not_ready`, and the route's code is
   * `session_busy` rather than the prompt's `turn_in_flight`: no turn is in
   * flight, and a client told one is would wait for a `turn_end` that never
   * comes.
   */
  check("a config change beside an in-flight clear is refused", (await managed.setConfigOption("thinking", "high")).kind, "busy");
  check("and so is a mode change, which is the one restoreConfig reverts", (await managed.setMode("plan")).kind, "busy");
  const configRefused = await clearApp.fetch(
    new Request(`http://d/sessions/${managed.id}/config`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ modeId: "plan" }),
    }),
  );
  const configBody = (await configRefused.json()) as any;
  check(
    "over HTTP that is a 409 that does not claim a turn is running",
    [configRefused.status, configBody?.error?.code],
    [409, "session_busy"],
  );
  /*
   * Refused *before* validation, which is what makes the guard a guard: the
   * agent's advertised set is read from a live session, and answering
   * `unknown_mode` here would be this daemon reporting on a conversation it is
   * halfway through discarding. A mode nothing has ever advertised is the case
   * that tells the two apart.
   */
  check("and refused before the mode is even looked up", (await managed.setMode("no-such-mode")).kind, "busy");

  /*
   * **The fifth method, which arrived exactly as the marker's docblock predicted.**
   *
   * A cancel inside this window would notify the id `session/close` is about to
   * destroy — stopping nothing, and looking from outside like an agent ignoring
   * it. `busy` and not `no_turn`, which is the answer the other guard order would
   * have given: a clear holds no turn, so testing `turn === null` first would tell
   * the caller "nothing is running, you have what you asked for" about a session
   * in the middle of an ACP round trip.
   */
  check("and a cancel beside an in-flight clear is refused too", (await managed.cancelTurn()).kind, "busy");
  const cancelRefused = await clearApp.fetch(
    new Request(`http://d/sessions/${managed.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  const cancelBody = (await cancelRefused.json()) as any;
  check(
    "over HTTP with the same code a config change gets, for the same reason",
    [cancelRefused.status, cancelBody?.error?.code],
    [409, "session_busy"],
  );

  const done = await clearing;
  check("the clear itself still lands", done.kind, "cleared");
  check("on a conversation the agent gave us", managed.agentSessionId, "conv_2");
  check("with the one it replaced closed rather than leaked", closed, ["conv_1"]);
  /*
   * And the marker is released in a `finally`, which is what stops a clear that
   * failed from leaving the session refusing every prompt for the rest of its
   * life. This is the control: without it every assertion above passes for a
   * session that has simply stopped accepting anything.
   */
  const after = await sendText("now it lands");
  check("and the session takes messages again once it is over", after.status, 202);
  /*
   * The control for the five `busy` answers above, and it is the same one the
   * prompt half gets: without it every assertion here passes for a session that
   * has simply stopped accepting anything. `unknown_mode` rather than `ok`
   * because this stub agent advertises no modes at all — which is exactly what
   * makes it the control, since it is the *validation* the guard was standing in
   * front of, now reached.
   */
  check("and config changes reach their own validation again", (await managed.setMode("plan")).kind, "unknown_mode");
  check("on the new conversation rather than the one that was closed", managed.agentSessionId, "conv_2");
  check("with exactly two conversations opened in total", conversations, 2);

  await clearRegistry.shutdown();
}
