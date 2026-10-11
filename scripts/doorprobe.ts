#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CLAUDE_DOORS } from "./doorprobe.claude.js";
import { CODEX_DOORS } from "./doorprobe.codex.js";
import { drive, type DoorRecipe } from "./doorprobe.drive.js";
import { GROK_DOORS } from "./doorprobe.grok.js";
import { KIMI_DOORS } from "./doorprobe.kimi.js";
import { OPENCODE_DOORS } from "./doorprobe.opencode.js";
import { parseScript, startRecorder, summarise } from "./doorprobe.recorder.js";
import { BUILTIN_CATALOGUE, type MachineCatalogue, type SystemConfig, type WireProtocol } from "../src/acp/systems.js";
import { ModelGatewayEndpoint } from "../src/gateway/endpoint.js";
import { REAL_UPSTREAM } from "../src/gateway/upstream.js";

/** Measures one way of pointing a harness at a foreign model endpoint, against a loopback recorder and no vendor. */

const DOORS: readonly DoorRecipe[] = [...CLAUDE_DOORS, ...CODEX_DOORS, ...KIMI_DOORS, ...OPENCODE_DOORS, ...GROK_DOORS];

const USAGE = `
Usage: pnpm doorprobe --door <agent>:<name> [options]

  --door          Which recipe to drive; --list names them.
  --script        What the recorder answers, one step per inference request, the last repeating:
                  text | thinking | error:<status> | cut | silent:<seconds>[:ping], each optionally *<count>.
                  Default: text.
  --model         The model the door is told to name. Default: probe-model.
  --prompt        A prompt; repeat it for more turns. Default: one turn.
  --resume        Afterwards end the process, reopen the conversation through the same door, prompt once more.
  --env K=V       Added to the door's spawn environment; repeatable.
  --blob-bytes    Size of the opaque reasoning blob a thinking step hands out. Default: 16384.
  --count-tokens  ok | 404. Default: ok.
  --turn-timeout  Seconds to wait for one turn. Default: 120.
  --scratch       A directory this run may fill. Default: a new one under the system's temporary directory.
  --dump          Write every request body under <scratch>/dump. They hold vendor prompts: keep them out of the repository.
  --gateway       messages | responses | chat. Put this daemon's own gateway between the harness and the recorder: the door is
                  handed the gateway's address and a one-launch credential, and the recorder stands where the vendor would.
  --upstream      messages | responses | chat. With --gateway: what the recorder is spoken to in, where that is another protocol
                  than the harness's and the gateway translates. Default: the same.
  --list          Print the recipes and exit.
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      door: { type: "string" },
      script: { type: "string", default: "text" },
      model: { type: "string", default: "probe-model" },
      prompt: { type: "string", multiple: true },
      resume: { type: "boolean", default: false },
      env: { type: "string", multiple: true },
      "blob-bytes": { type: "string", default: "16384" },
      "count-tokens": { type: "string", default: "ok" },
      "turn-timeout": { type: "string", default: "120" },
      scratch: { type: "string" },
      dump: { type: "boolean", default: false },
      gateway: { type: "string" },
      upstream: { type: "string" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    for (const door of DOORS) console.log(`${door.agent}:${door.name}\n    ${door.about}`);
    return 0;
  }
  const recipe = DOORS.find((door) => `${door.agent}:${door.name}` === values.door);
  if (recipe === undefined) {
    console.error(`error: --door must be one of ${DOORS.map((door) => `${door.agent}:${door.name}`).join(", ")}\n\n${USAGE}`);
    return 2;
  }
  const countTokens = values["count-tokens"];
  if (countTokens !== "ok" && countTokens !== "404") {
    console.error(`error: --count-tokens is ok or 404`);
    return 2;
  }
  const extraEnv: NodeJS.ProcessEnv = {};
  for (const pair of values.env ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) {
      console.error(`error: --env takes KEY=VALUE, got "${pair}"`);
      return 2;
    }
    extraEnv[pair.slice(0, at)] = pair.slice(at + 1);
  }

  const scratch = values.scratch === undefined ? mkdtempSync(join(tmpdir(), "doorprobe-")) : resolve(values.scratch);
  const cwd = join(scratch, "work");
  mkdirSync(cwd, { recursive: true });
  const through = values.gateway === undefined ? null : GATEWAY_PROTOCOLS[values.gateway];
  if (through === undefined) {
    console.error(`error: --gateway is one of ${Object.keys(GATEWAY_PROTOCOLS).join(", ")}`);
    return 2;
  }
  const beyond = values.upstream === undefined ? through : GATEWAY_PROTOCOLS[values.upstream];
  if (beyond === undefined || (beyond !== through && through === null)) {
    console.error(`error: --upstream is one of ${Object.keys(GATEWAY_PROTOCOLS).join(", ")}, and needs --gateway`);
    return 2;
  }
  // With the gateway between them the recorder is the vendor, so what it must be shown is the vendor's key and never the launch's.
  const bearer = `${through === null ? "probe" : "vendor"}-${randomBytes(24).toString("hex")}`;
  const recorder = await startRecorder({
    script: parseScript(values.script),
    bearer,
    blobBytes: Number(values["blob-bytes"]),
    countTokens,
    dumpDir: values.dump ? join(scratch, "dump") : null,
  });
  const out = (line: string): void => {
    console.log(line);
  };

  const gateway =
    through === null
      ? null
      : await ModelGatewayEndpoint.listen({ secretFor: async () => bearer, machine: () => PROBE_MACHINE, transport: REAL_UPSTREAM });
  const grant =
    gateway === null || through === null || beyond === null
      ? null
      : gateway.open({
          system: PROBE_SYSTEM,
          model: values.model,
          inbound: through,
          outbound: { protocol: beyond, baseUrl: beyond === "anthropic-messages" ? recorder.baseUrl : `${recorder.baseUrl}/v1` },
          onFault: (fault) => out(`  gateway refused: ${fault.code} — ${fault.message}`),
        });

  out(`door ${recipe.agent}:${recipe.name} — ${recipe.about}`);
  out(`recorder ${recorder.baseUrl}  script=${values.script}  model=${values.model}  scratch=${scratch}`);
  if (grant !== null) {
    out(`gateway ${grant.origin} in front of it: ${through} from the harness${beyond === through ? "" : `, translated into ${beyond}`}; the recorder should see the vendor's key as "the probe's own"`);
  }
  out("");
  try {
    await drive({
      recipe,
      route: { baseUrl: grant?.origin ?? recorder.baseUrl, bearer: grant?.bearer ?? bearer, model: values.model, scratch, protocol: through },
      cwd,
      prompts: values.prompt ?? ["Reply with one word."],
      turnTimeoutMs: Number(values["turn-timeout"]) * 1000,
      resume: values.resume,
      extraEnv,
      out,
    });
  } finally {
    await gateway?.close();
    await recorder.close();
  }

  out("");
  out(`recorder saw ${recorder.requests.length} requests:`);
  for (const entry of recorder.requests) {
    const flags = [
      entry.blob === "absent" ? "" : `blob ${entry.blob}`,
      entry.clientClosedEarly ? "client hung up early" : "",
    ].filter((flag) => flag !== "");
    out(`#${entry.n} +${(entry.atMs / 1000).toFixed(1)}s ${entry.method} ${entry.path} [${entry.kind}] ${entry.bodyBytes}B → ${entry.answered}${flags.length > 0 ? `  (${flags.join("; ")})` : ""}`);
    const shown = Object.entries(entry.headers).filter(([name]) => !QUIET_HEADERS.has(name));
    out(`    headers: ${shown.map(([name, value]) => `${name}: ${value}`).join(" | ")}`);
    for (const line of summarise(entry)) out(`    ${line}`);
  }
  return 0;
}

const GATEWAY_PROTOCOLS: Record<string, WireProtocol> = {
  messages: "anthropic-messages",
  responses: "openai-responses",
  chat: "openai-chat",
};

const PROBE_SYSTEM = "doorprobe";
const PROBE_SPEC: SystemConfig = {
  displayName: "The recorder",
  apiType: "anthropic",
  endpoints: {},
  authHeader: { name: "authorization", prefix: "Bearer " },
  nativeHarness: null,
  loginVia: null,
  models: [],
  nativeModelPrefix: null,
  keyEnv: null,
  signIn: null,
};
const PROBE_MACHINE: MachineCatalogue = {
  ...BUILTIN_CATALOGUE,
  system: (id) => (id === PROBE_SYSTEM ? PROBE_SPEC : BUILTIN_CATALOGUE.system(id)),
};

const QUIET_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "accept-language", "sec-fetch-mode"]);

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
