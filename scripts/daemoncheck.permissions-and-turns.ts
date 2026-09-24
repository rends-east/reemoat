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

/** Parses defensively: a non-JSON body (Hono's own plain-text 404) comes back as a value, since a throw would end the run. */
const answerPermission = async (
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
    return { status: response.status, body: { nonJsonBody: text } };
  }
};

process.stdout.write("\nanswering a permission the agent is waiting on\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  // A fresh pipe pair per launch: two AcpClients on one stream cross their routing.
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

        // A response, not a call: the answer to this agent's permission request, which the held turn waits on.
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
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            // The second agent never asks; "run it" makes a later one ask, so no section depends on its spawn ordinal.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  // Long enough for a prompt to reach the pipes and the permission request to come back.
  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  // Never index with a non-null assertion: a regression must fail a case, not crash the run.
  // The fallback is a real path segment, so the handler refuses it in JSON instead of Hono's plain-text 404.
  const NOTHING_PENDING = "no-pending-permission";
  const waitingOn = (): string => blocked.snapshot().pendingPermissions[0]?.permissionId ?? NOTHING_PENDING;

  const workdir = tmp("permcheck-");
  const blocked = await permRegistry.create({ agent: "kimi", cwd: workdir });
  const idle = await permRegistry.create({ agent: "kimi", cwd: workdir });
  // Pinned, so the ordering assertion below has something to beat: pinned ranks immediately under blocked.
  idle.setMeta({ pinned: true });

  blocked.prompt("do the thing");
  await quiesce();

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
  check("the raw arguments come with it", (pending[0]?.rawInput as any)?.command, "rm -rf /");
  check("and so does the text block, which is where kimi puts the command", Array.isArray(pending[0]?.content), true);

  // Blocked outranks everything, which is what makes ?limit= safe; only provable here, as a restored row holds no permission.
  const cut = await permApp.fetch(
    new Request("http://d/sessions?limit=1", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a cut of one keeps the blocked session, over a pinned one",
    ((await cut.json()) as any).sessions.map((s: { id: string }) => s.id),
    [blocked.id],
  );

  const permissionId = pending[0]?.permissionId ?? "";
  const ok = await answer(blocked.id, permissionId, { optionId: "o_always" });
  check("answering it is a 200", ok.status, 200);
  check("recorded, and not a repeat", [ok.body.recorded, ok.body.repeat], [true, false]);
  check("with the outcome and the option that was picked", [ok.body.outcome, ok.body.optionId], ["selected", "o_always"]);
  check("and an honest word about delivery rather than a claim of effect", ok.body.delivered, "sent");

  await quiesce();
  // The one observable of settle's order: if the append ran first and threw, this would be empty after a 200.
  check("the agent really was unblocked, with the option a human picked", answered.length, 1);
  check("and it is the one they picked, not the agent's own preference", (answered[0]?.outcome as any)?.optionId, "o_always");
  check("the session stops being blocked", blocked.status, "idle");
  check("and its snapshot holds no question", blocked.snapshot().pendingPermissions.length, 0);

  const resolvedEvents = blocked.log
    .read(0, 200, 1 << 20)
    .map((stored) => stored.event)
    .filter((event) => event.type === "permission_resolved");
  check("the resolution is in the log", resolvedEvents.length, 1);
  check("attributed to the client rather than to a sweep", (resolvedEvents[0] as any)?.by, "client");

  // A 409 with a success-shaped body: packages/web/src/http.ts keys on the absent error envelope, so the two must not drift.
  const again = await answer(blocked.id, permissionId, { optionId: "o_yes" });
  check("answering the same one twice is a 409", again.status, 409);
  check("but the body says it landed, because it did", again.body.recorded, true);
  check("and says which time this was", again.body.repeat, true);
  check("carrying the outcome of the answer that won, not the one just sent", again.body.optionId, "o_always");
  check("with no error envelope at all, which is what a client keys on", "error" in again.body, false);
  check("and the agent was not told twice", answered.length, 1);

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

  process.stdout.write("\nwhat an answer is allowed to say\n");

  blocked.prompt("do a third thing");
  await quiesce();
  const third = waitingOn();

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
    check(
      "and the refusal carries what was actually on offer",
      wrong.body.error?.detail?.options?.map((option: { optionId: string }) => option.optionId),
      ["o_yes", "o_always", "o_no", "o_never"],
    );
  }

  // A decision word is a preference order over kinds, not an id: allow falls back to allow_always, reject_always to reject_once.
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
    // The narrow offer still parks, so a reject fails against a live permission rather than taking the cancel path.
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

  const standIn = await answer(blocked.id, NOTHING_PENDING, { cancel: true });
  check("and so is the stand-in a broken run would send", standIn.status, 404);
  check("answered by the handler in this daemon's own envelope", standIn.body?.error?.code, "permission_not_found");

  await permRegistry.shutdown();

  {
    // Driven through the wire: title and options ride the snapshot, so the pair is refused over 8 KiB rather than clipped.
    const shouted = await permRegistry.create({ agent: "kimi", cwd: workdir });
    shouted.prompt("run it, shouting");
    await quiesce();
    check("a 50 KB title is refused rather than parked", shouted.snapshot().pendingPermissions.length, 0);
    check("so the session is not left blocked on it either", shouted.status === "blocked", false);
    await permRegistry.stop(shouted.id);

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

    // Weighed in bytes, not UTF-16 units: 8,000 CJK characters are under 8 KiB of units and 24 KiB on the wire.
    const cjk = await permRegistry.create({ agent: "kimi", cwd: workdir });
    cjk.prompt("run it, in Chinese");
    await quiesce();
    check("a title that is 8 KiB of characters and 24 KiB of bytes is refused too", cjk.snapshot().pendingPermissions.length, 0);
    check("and that session is not left blocked on it either", cjk.status === "blocked", false);
    await permRegistry.stop(cjk.id);
  }

  {
    // Refused whole rather than trimmed: an optionId round-trips verbatim, so a clipped or dropped option is an answer the agent cannot use.
    const swarmed = await permRegistry.create({ agent: "kimi", cwd: workdir });
    swarmed.prompt("run it, swarming");
    await quiesce();
    check("200 options is refused rather than parked", swarmed.snapshot().pendingPermissions.length, 0);
    check("so the session is not left blocked on it", swarmed.status === "blocked", false);
    await permRegistry.stop(swarmed.id);
  }
}

process.stdout.write("\nanswering a question the agent is waiting on\n");
{
  const acp = await import("@agentclientprotocol/sdk");

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
            // AskUserQuestion's shape: a titled single-select plus the adapter's own free-text box.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  const NOTHING_PENDING = "no-pending-elicitation";
  const askingOn = (): string =>
    asked.snapshot().pendingElicitations[0]?.elicitationId ?? NOTHING_PENDING;

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
  check("and none of them settled it", asked.status, "blocked");
  check("nor was the agent told anything", answered.length, 0);

  const settledId = askingOn();
  const ok = await reply(settledId, { content: { question_0: "React" } });
  check("a valid answer is recorded", [ok.status, ok.body?.recorded, ok.body?.action], [200, true, "accept"]);
  await quiesce();

  // Pins settleElicitation's order: the agent is handed the typed content before anything is logged.
  check("and the agent really was handed it", answered[0]?.content, { question_0: "React" });
  check("the session is no longer blocked", asked.status, "idle");
  check("and holds no question", asked.snapshot().pendingElicitations.length, 0);

  // value is the option's label, never its wire value, so a transcript renders it with no join.
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

  const again = await reply(settledId, { content: { question_0: "Svelte" } });
  check(
    "answering again is a 409 carrying a success-shaped body",
    [again.status, again.body?.recorded, again.body?.repeat],
    [409, true, true],
  );
  check("naming the answer that won", again.body?.action, "accept");
  check("and it is not an error envelope", again.body?.error, undefined);

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

// Three cancel behaviours: "ask me" parks a permission, "work quietly" complies, "ignore me" never answers (legal).
process.stdout.write("\nstopping the turn without stopping the session\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** Every `session/cancel` this daemon sent, by the session id it named. */
  const cancelsSeen: string[] = [];
  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  const spawnAgent = (): AgentProcess => {
    const sessionId = "s_cancel_1";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    let heldPromptId: unknown = null;
    let cancelled = false;
    let stubborn = false;
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
            if (heldPromptId !== null && !stubborn && pendingAsk === null) {
              send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "cancelled" } });
              heldPromptId = null;
            }
            break;
          }
          case acp.methods.agent.session.prompt: {
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            // A rejected prompt, the shape of a provider failure: -32603 with upstream prose and no errorKind, so isAuthFailure ignores it.
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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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

  // A 200, not a 409: an agent that is not working is also what a lost race between the tap and the turn's end looks like.
  const idleAnswer = await postCancel(live.id);
  check("cancelling with nothing in flight is a 200", idleAnswer.status, 200);
  check("saying plainly that nothing was cancelled", [idleAnswer.body.cancelled, idleAnswer.body.turn], [false, null]);
  check("and that there is nothing left to wait for", idleAnswer.body.settled, true);
  check("with no notification sent to the agent at all", cancelsSeen.length, 0);

  live.prompt("work quietly");
  await quiesce();
  check("a turn is in flight", live.status, "running");

  const quiet = await postCancel(live.id);
  check("cancelling it is a 200", quiet.status, 200);
  check("naming the turn it stopped", [quiet.body.cancelled, quiet.body.turn], [true, 1]);
  check("and reporting that the agent really finished", quiet.body.settled, true);
  // Why the stub has a cancel arm: a notification has no id, so default would drop it and every case here would pass anyway.
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

  // Why cancelTurn sweeps after sending: this agent answers only once its permission is settled, so waiting first would time out.
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

  // The only line that fails if the daemon sweeps before sending: the stub says cancelled only if the cancel beat the answer.
  check(
    "and this turn ended as cancelled too, which only send-then-sweep achieves",
    eventsOf("turn_end").map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["cancelled", "cancelled"],
  );

  const sweptBy = eventsOf("permission_resolved").at(-1);
  check(
    "attributed to the cancel rather than to a stop or a turn that ended",
    sweptBy?.type === "permission_resolved" ? sweptBy.by : null,
    "turn_cancelled",
  );

  // A rejected prompt still gets a turn_end, written by the daemon because the agent never gets to (Q2.103).
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
  // agent_error, not an ACP reason: refusal or cancelled would lie; it still cuts Tail.taskFloor so a failed turn stops counting pending calls.
  check(
    "carrying the reason ACP has no word for, because ACP never got that far",
    eventsOf("turn_end")
      .slice(endsBefore)
      .map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["agent_error"],
  );
  check("exactly one end for one prompt, which is the whole property", eventsOf("turn_end").length - endsBefore, 1);
  // A provider error arrives through the generator, so onAgentUnusable must not fire; the next block prompts this same session.
  check("with no exit recorded, because a bad turn is not a dead agent", live.snapshot().exit, null);

  live.prompt("ignore me");
  await quiesce();
  const ignored = await postCancel(live.id);
  check("cancelling an agent that will not stop is still a 200", ignored.status, 200);
  check("the daemon says it asked", ignored.body.cancelled, true);
  check("and says honestly that the agent has not finished", ignored.body.settled, false);
  check("the turn is still in flight, so the session still reads running", live.status, "running");
  // cancelRequestedAt draws the composer's Stop button and must survive an unsettled cancel, or the control re-arms.
  check("and the snapshot still says somebody asked", typeof live.snapshot().cancelRequestedAt, "number");

  // Not memoised, unlike `stop()`: asking twice is a person tapping again, and
  // the honest answer is to ask the agent again rather than replay the first.
  const twice = await postCancel(live.id);
  check("asking twice is allowed rather than deduplicated", twice.body.cancelled, true);
  check("and really did send a second notification for this turn", cancelsSeen.length, 4);

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

  check("a sequence this daemon never reached is a 404", (await ask("perm-9-abc")).status, 404);
  check("and another daemon's salt is too, however well formed", (await ask("perm-2-def")).status, 404);
  check("as is something that is not an id at all", (await ask("perm-x-abc")).status, 404);
  check("the boundary is inclusive: the last id it minted is still recognised", (await ask("perm-3-abc")).status, 409);

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

// /clear is carried out by the daemon, not forwarded: forwarding made claude fork underneath ACP onto an id nobody reported.
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
  check("and the session is now on it", session.sessionId, "conv_2");
  check("the old conversation is closed rather than leaked", closed, ["conv_1"]);
  check("and `/clear` was never forwarded as a prompt", prompts, []);

  for await (const _event of session.prompt("hello")) {
    // Drained rather than ignored: the generator is what runs the turn.
  }
  check("the next prompt goes to the new conversation", prompts, ["conv_2:hello"]);

  await session.dispose();
}

// During a clear's re-key a prompt, second clear, config change or cancel must be refused, or it reaches the conversation being closed.
// A rig of its own: this needs the registry, the routes and a session/new that answers late.

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
      return [{ id: "kimi", displayName: "fake", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
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
  // The marker is set before clearContext's first await, the only reason a synchronous prompt can see it.
  check("a prompt beside an in-flight clear is refused", managed.prompt("hello").kind, "busy");
  check("and a second clear is refused the same way", (await managed.clearContext("/clear")).kind, "busy");
  const refused = await sendText("hello over http");
  check("over HTTP it is the 409 a mid-turn message gets", [refused.status, refused.body?.error?.code], [409, "turn_in_flight"]);
  check("with a status that still says idle, because a clear is not a turn", refused.body?.error?.detail?.status, "idle");

  // parkable must refuse mid-clear: status reads idle, and releaseOneSlot asks with idleMs 0, so a stop here would fork the conversation (Q2.7).
  check("a session mid-clear is not one the sweep may take", managed.parkable(Date.now(), 30 * 60_000), false);
  check("nor one a ceiling may take, which asks with no threshold at all", managed.parkable(Date.now(), 0), false);

  // Session reads its id at request time and restoreConfig would revert a tap, so these are refused too: session_busy, since no turn runs.
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
  check("and refused before the mode is even looked up", (await managed.setMode("no-such-mode")).kind, "busy");

  // busy, not no_turn: testing for no turn first would tell the caller nothing is running mid round trip.
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
  // The control: the marker is released in a finally, and without this every busy above passes for a session that accepts nothing.
  const after = await sendText("now it lands");
  check("and the session takes messages again once it is over", after.status, 202);
  // unknown_mode because this stub advertises no modes: the validation the guard stood in front of is reached again.
  check("and config changes reach their own validation again", (await managed.setMode("plan")).kind, "unknown_mode");
  check("on the new conversation rather than the one that was closed", managed.agentSessionId, "conv_2");
  check("with exactly two conversations opened in total", conversations, 2);

  await clearRegistry.shutdown();
}
