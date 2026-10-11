import { execFileSync } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { AcpClient, type SessionHandlers } from "../src/acp/client.js";
import type { BuiltinAgentId } from "../src/acp/agents.js";
import type { AgentRouting, WireProtocol } from "../src/acp/systems.js";
import { LocalRuntime } from "../src/runtime/local.js";

/** What a door is handed: where the recorder listens, the credential it expects back, and the model to name. */
export interface ProbeRoute {
  baseUrl: string;
  bearer: string;
  model: string;
  /** A directory this run owns, for a relocated home or a config file; never under somebody's own home. */
  scratch: string;
  /** What the gateway in front of the recorder speaks, where there is one. */
  protocol: WireProtocol | null;
}

/** One way of pointing a harness at a foreign endpoint, to be measured before it becomes a table row. */
export interface DoorRecipe {
  agent: BuiltinAgentId;
  name: string;
  about: string;
  /** Launch as a routed pairing does: the harness's own pasted credentials are withheld. */
  routed: boolean;
  spawnEnv(route: ProbeRoute): NodeJS.ProcessEnv;
  /** Sent as providers/set between initialize and session/new, where the door is ACP's. */
  provider?(route: ProbeRoute, routing: AgentRouting): acp.SetProviderRequest;
  /** The value to put on the model control after the session opens; null leaves the control alone. */
  pin?(route: ProbeRoute): string | null;
}

export interface DriveOptions {
  recipe: DoorRecipe;
  route: ProbeRoute;
  cwd: string;
  prompts: readonly string[];
  turnTimeoutMs: number;
  /** After the turns: end the process, start another through the same door, reopen the conversation, prompt once more. */
  resume: boolean;
  extraEnv: NodeJS.ProcessEnv;
  out(line: string): void;
}

const NEW_SESSION_TIMEOUT_MS = 60_000;
const SET_TIMEOUT_MS = 20_000;

export async function drive(options: DriveOptions): Promise<void> {
  const { recipe, route, out } = options;
  const scrub = (text: string): string => text.split(route.bearer).join("‹probe bearer›");
  const first = await open(options, scrub);
  if (first === null) return;
  let { client } = first;
  let sessionId: string | null = null;

  try {
    const opened = await attempt("session/new", NEW_SESSION_TIMEOUT_MS, () =>
      client.agent.request(acp.methods.agent.session.new, { cwd: options.cwd, mcpServers: [] }),
    );
    if (!opened.ok) {
      out(`session/new REFUSED: ${scrub(opened.error)}`);
      return;
    }
    sessionId = opened.value.sessionId;
    out(`session/new ok: ${sessionId}`);
    reportModelControl(opened.value, route.model, out);
    reportArgv(first.pid, route, out);

    const turns = collector(client, sessionId);
    const wanted = recipe.pin?.(route) ?? null;
    if (wanted !== null) {
      const control = modelControl(opened.value);
      if (control === null) {
        out(`pin: no control with category "model" to set`);
      } else {
        const set = await attempt("session/set_config_option", SET_TIMEOUT_MS, () =>
          client.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId: sessionId as string,
            configId: control.id,
            value: wanted,
          }),
        );
        out(set.ok ? `pin ${control.id}=${wanted}: accepted` : `pin ${control.id}=${wanted}: REFUSED ${scrub(set.error)}`);
        if (set.ok) reportModelControl(set.value, route.model, out);
      }
    }

    for (const [index, prompt] of options.prompts.entries()) {
      await turn(client, sessionId, prompt, `turn ${index + 1}`, options, turns, scrub);
    }

    if (options.resume) {
      const resumable = client.supportsSessionResume() ? "resume" : client.supportsSessionLoad() ? "load" : null;
      await client.close();
      if (resumable === null) {
        out(`resume: the agent advertises neither session/resume nor session/load`);
        return;
      }
      const second = await open(options, scrub);
      if (second === null) return;
      client = second.client;
      const again = collector(client, sessionId);
      const reopen = { sessionId, cwd: options.cwd, mcpServers: [] };
      const reopened = await attempt(`session/${resumable}`, NEW_SESSION_TIMEOUT_MS, () =>
        resumable === "resume"
          ? client.agent.request(acp.methods.agent.session.resume, reopen)
          : client.agent.request(acp.methods.agent.session.load, reopen),
      );
      if (!reopened.ok) {
        out(`session/${resumable} REFUSED: ${scrub(reopened.error)}`);
        return;
      }
      out(`session/${resumable} ok`);
      reportModelControl(reopened.value, route.model, out);
      await turn(client, sessionId, "Reply with one word.", "turn after resume", options, again, scrub);
    }
  } finally {
    const logs = client.recentLogs();
    if (logs.length > 0) {
      out(`agent stderr, last ${logs.length} lines:`);
      for (const line of logs) out(`  ${scrub(line).slice(0, 400)}`);
    }
    await client.close();
  }
}

async function open(
  options: DriveOptions,
  scrub: (text: string) => string,
): Promise<{ client: AcpClient; pid: number | null } | null> {
  const { recipe, route, out } = options;
  const runtime = new LocalRuntime();
  let config;
  try {
    config = runtime.describe(recipe.agent);
  } catch (error) {
    out(`cannot launch ${recipe.agent}: ${message(error)}`);
    return null;
  }
  const env = { ...recipe.spawnEnv(route), ...options.extraEnv };
  out(`spawn ${config.command} ${config.args.join(" ")}`.trimEnd());
  out(`  door env: ${Object.keys(env).length === 0 ? "none" : Object.entries(env).map(([k, v]) => `${k}=${scrub(clip(v ?? "", 200))}`).join("  ")}`);
  const child = await runtime.launch(recipe.agent, env, recipe.routed, options.cwd);
  const pid = child.handle?.kind === "local" ? child.handle.pid : null;
  let client: AcpClient;
  try {
    client = await AcpClient.launch(config, child, { fileIo: false, elicitation: false, authMethod: null });
  } catch (error) {
    out(`initialize FAILED: ${scrub(message(error))}`);
    return null;
  }
  const init = client.initializeResult;
  const info = init.agentInfo ? `${init.agentInfo.name} ${init.agentInfo.version}` : "?";
  const caps = init.agentCapabilities ?? {};
  const authMethods = (init.authMethods ?? []).map((method) => method.id).join(", ");
  out(`initialize ok: ${info}`);
  out(`  capabilities: ${Object.keys(caps).join(", ") || "none"}`);
  out(`  providers marker: ${caps.providers == null ? "absent" : "present"}; authMethods: ${authMethods || "none"}`);

  if (recipe.provider !== undefined) {
    const routing = await client.routing();
    if (routing === null) {
      out(`providers/list: no usable answer, so nothing can be set`);
      await client.close();
      return null;
    }
    out(`providers/list: providerId=${routing.providerId} supported=${routing.supported.join(",")}`);
    const request = recipe.provider(route, routing);
    const set = await attempt("providers/set", SET_TIMEOUT_MS, () => client.setProvider(request));
    out(set.ok ? `providers/set ${request.apiType} → ${request.baseUrl}: accepted` : `providers/set REFUSED: ${scrub(set.error)}`);
    if (!set.ok) {
      await client.close();
      return null;
    }
  }
  return { client, pid };
}

interface TurnLog {
  text: string;
  thought: string;
  kinds: Map<string, number>;
  reset(): void;
}

function collector(client: AcpClient, sessionId: string): TurnLog {
  const log: TurnLog = {
    text: "",
    thought: "",
    kinds: new Map(),
    reset() {
      this.text = "";
      this.thought = "";
      this.kinds = new Map();
    },
  };
  const refuse = (method: string) => (): Promise<never> => Promise.reject(acp.RequestError.methodNotFound(method));
  const handlers: SessionHandlers = {
    onUpdate: () => {},
    onDelegatedUpdate: () => {},
    onPermission: () => Promise.resolve({ outcome: { outcome: "cancelled" } }),
    onReadTextFile: refuse("fs/read_text_file"),
    onWriteTextFile: refuse("fs/write_text_file"),
    onElicitation: refuse("elicitation/create"),
    onXaiQuestion: refuse("xai/ask_user_question"),
    onXaiPlan: refuse("xai/exit_plan_mode"),
    onXaiMcpElicit: refuse("xai/mcp_elicit"),
    onXaiInteractionResolved: () => {},
    onCursorQuestion: refuse("cursor/ask_question"),
    onCursorPlan: refuse("cursor/create_plan"),
    onCursorTodos: () => {},
    onCursorImage: () => {},
  };
  client.registerSession(sessionId, handlers);
  client.onNotification((notification) => {
    const update = notification.update as { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown } };
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "?";
    log.kinds.set(kind, (log.kinds.get(kind) ?? 0) + 1);
    const text = update.content?.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
    if (kind === "agent_message_chunk") log.text += text;
    if (kind === "agent_thought_chunk") log.thought += text;
  });
  return log;
}

async function turn(
  client: AcpClient,
  sessionId: string,
  prompt: string,
  label: string,
  options: DriveOptions,
  log: TurnLog,
  scrub: (text: string) => string,
): Promise<void> {
  log.reset();
  const started = Date.now();
  const answer = await attempt("session/prompt", options.turnTimeoutMs, () =>
    client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: prompt }] }),
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (answer.ok) {
    const usage = answer.value.usage == null ? "" : ` usage=${JSON.stringify(answer.value.usage)}`;
    options.out(`${label}: stopReason=${answer.value.stopReason} in ${seconds}s${usage}`);
  } else {
    options.out(`${label}: FAILED in ${seconds}s — ${scrub(answer.error)}`);
  }
  const kinds = [...log.kinds.entries()].map(([kind, count]) => `${kind}×${count}`).join(" ");
  options.out(`  updates: ${kinds || "none"}`);
  if (log.text !== "") options.out(`  said: ${JSON.stringify(clip(scrub(log.text), 300))}`);
  if (log.thought !== "") options.out(`  thought: ${JSON.stringify(clip(scrub(log.thought), 200))}`);
}

interface ModelControl {
  id: string;
  current: string;
  values: string[];
}

function modelControl(response: unknown): ModelControl | null {
  const options = (response as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(options)) return null;
  for (const raw of options) {
    const option = (raw ?? {}) as { id?: unknown; category?: unknown; currentValue?: unknown; options?: unknown };
    if (option.category !== "model" || typeof option.id !== "string") continue;
    const values: string[] = [];
    const walk = (list: unknown): void => {
      if (!Array.isArray(list)) return;
      for (const one of list) {
        const choice = (one ?? {}) as { value?: unknown; options?: unknown };
        if (typeof choice.value === "string") values.push(choice.value);
        walk(choice.options);
      }
    };
    walk(option.options);
    return { id: option.id, current: typeof option.currentValue === "string" ? option.currentValue : "?", values };
  }
  return null;
}

function reportModelControl(response: unknown, model: string, out: (line: string) => void): void {
  const control = modelControl(response);
  if (control === null) {
    out(`  model control: none published`);
    return;
  }
  const exact = control.values.includes(model);
  const spelled = control.values.filter((value) => value !== model && value.endsWith(model));
  out(`  model control: id=${control.id} current=${control.current} choices=${control.values.length}`);
  out(`    probe model listed: ${exact ? "yes, as named" : spelled.length > 0 ? `as ${spelled.join(", ")}` : "no"}`);
  out(`    first choices: ${control.values.slice(0, 8).join(", ")}${control.values.length > 8 ? ", …" : ""}`);
}

/** Whether the credential or the address reached a command line in the agent's process group, where ps shows it to every user. */
function reportArgv(pid: number | null, route: ProbeRoute, out: (line: string) => void): void {
  if (pid === null) return;
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    out(`  argv check: ps could not be run`);
    return;
  }
  const mine = listing.split("\n").filter((line) => line.trim().startsWith(`${pid} `));
  // The program and the words around the hit, so the report says which flag carried it.
  const around = (line: string, needle: string, as: string): string => {
    const program = (line.trim().split(/\s+/)[1] ?? "?").split("/").pop() ?? "?";
    const at = line.indexOf(needle);
    const before = line.slice(Math.max(0, at - 90), at).split(route.bearer).join("‹probe bearer›");
    return `${program}: …${before}${as}`;
  };
  const withBearer = mine.filter((line) => line.includes(route.bearer));
  const withUrl = mine.filter((line) => line.includes(route.baseUrl));
  out(`  argv check over ${mine.length} processes in the group:`);
  out(`    bearer on a command line: ${withBearer.length === 0 ? "no" : "YES"}`);
  for (const line of withBearer) out(`      ${around(line, route.bearer, "‹probe bearer›")}`);
  out(`    address on a command line: ${withUrl.length === 0 ? "no" : "yes"}`);
  for (const line of withUrl) out(`      ${around(line, route.baseUrl, "‹address›")}`);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(label: string, timeoutMs: number, run: () => Promise<T>): Promise<Attempt<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: message(error) };
  } finally {
    clearTimeout(timer);
  }
}

function message(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const data = error.data === undefined ? "" : ` data=${clip(JSON.stringify(error.data), 600)}`;
    return `code=${error.code} ${error.message}${data}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}
