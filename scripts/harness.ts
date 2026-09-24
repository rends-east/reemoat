#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { AGENT_IDS, isBuiltinAgentId, AgentUnavailableError } from "../src/acp/agents.js";
import { Session } from "../src/session.js";
import type { SessionEvent } from "../src/events.js";

const USAGE = `
Usage: pnpm harness --agent <${AGENT_IDS.join("|")}> --cwd <dir> --prompt <text> [--json] [--raw] [--no-logs]

  --agent     Which ACP agent to spawn.
  --cwd       Session root. Defaults to the current directory.
  --prompt    The prompt to send.
  --json      Emit the normalized events as NDJSON instead of pretty output.
  --raw       Also emit every session/update exactly as the agent sent it.
  --no-logs   Suppress the agent's stderr lines.
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string" },
      cwd: { type: "string" },
      prompt: { type: "string" },
      json: { type: "boolean", default: false },
      raw: { type: "boolean", default: false },
      // allowNegative is what lets the documented --no-logs parse under strict.
      logs: { type: "boolean", default: true },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowNegative: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  // Built-ins only: a bare Session has no store to resolve a plugin harness from.
  if (!values.agent || !isBuiltinAgentId(values.agent)) {
    console.error(`error: --agent must be one of ${AGENT_IDS.join(", ")}\n\n${USAGE}`);
    return 2;
  }
  if (!values.prompt) {
    console.error(`error: --prompt is required\n\n${USAGE}`);
    return 2;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const printer = values.json ? jsonPrinter() : prettyPrinter(values.logs);

  // Having a resolver declares elicitation support, without which claude's adapter disallows AskUserQuestion; it declines rather than invent an answer.
  const session = await Session.start({
    agent: values.agent,
    cwd,
    elicitations: async (request) => {
      process.stdout.write(
        `${JSON.stringify({
          _question: {
            toolCallId: request.toolCallId,
            message: request.message,
            fields: request.form.fields,
          },
        })}\n`,
      );
      return { action: "decline" };
    },
  });

  // Tagged _raw so --raw --json stays one NDJSON stream; subscribed after start, so handshake updates are not seen.
  const offRaw = values.raw
    ? session.onRawUpdate((notification) => {
        process.stdout.write(`${JSON.stringify({ _raw: notification })}\n`);
      })
    : () => {};

  printer.print({ type: "agent_config", ...session.agentConfig });
  const offConfig = session.onConfigChanged((config) => {
    printer.print({ type: "agent_config", ...config });
  });

  // Read once, then subscribed: usage is out of band, and between turns there is no next update.
  const initialUsage = session.contextUsage;
  if (initialUsage !== null) {
    printer.print({ type: "context_usage", used: initialUsage.used, size: initialUsage.size });
  }
  const offUsage = session.onUsageChanged((usage) => {
    printer.print({ type: "context_usage", used: usage.used, size: usage.size });
  });

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    process.stderr.write("\ninterrupted — cancelling the turn…\n");
    void session.dispose();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let exitCode = 1;
  try {
    for await (const event of session.prompt(values.prompt)) {
      printer.print(event);
      if (event.type === "turn_end") exitCode = event.stopReason === "end_turn" ? 0 : 1;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    offConfig();
    offUsage();
    offRaw();
    await session.dispose();
  }

  printer.summary();
  return interrupted ? 130 : exitCode;
}

/** Wider than SessionEvent: context_usage is not a wire event and exists only in this file. */
type Printable = SessionEvent | { type: "context_usage"; used: number; size: number };

interface Printer {
  print(event: Printable): void;
  summary(): void;
}

function jsonPrinter(): Printer {
  return {
    print(event) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
    summary() {},
  };
}

function prettyPrinter(showLogs: boolean): Printer {
  const color = process.stdout.isTTY;
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  const bold = (text: string) => (color ? `\x1b[1m${text}\x1b[0m` : text);

  const start = Date.now();
  const counts = new Map<string, number>();
  /** An unseen parent renders at depth 0, as in the browser; the daemon never reorders to build a tree. */
  const parents = new Map<string, string | null>();
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let at = parents.get(id); at != null && depth < 8; at = parents.get(at)) depth += 1;
    return depth;
  };
  let stopReason: string | null = null;
  let streamingText = false;
  /** Reasoning and reply stream separately; a switch has to break the line. */
  let streamingThought = false;

  const stamp = () => dim(`${((Date.now() - start) / 1000).toFixed(1).padStart(5)}s `);
  const line = (text: string) => {
    if (streamingText) {
      process.stdout.write("\n");
      streamingText = false;
    }
    process.stdout.write(`${stamp()}${text}\n`);
  };

  return {
    print(event) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

      switch (event.type) {
        case "session_started": {
          const info = event.agentInfo ? `${event.agentInfo.name} ${event.agentInfo.version}` : "?";
          line(`${bold("▸ session")} ${event.sessionId}  ${dim(`${event.agent} · ${info}`)}`);
          if (event.modes) {
            const ids = event.modes.available.map((mode) => mode.id).join(", ");
            line(dim(`  modes: ${ids} (current: ${event.modes.current})`));
          }
          break;
        }
        case "context_usage": {
          // A percentage, because that is what clients draw and what the registry's fan-out is keyed on.
          const pct = event.size > 0 ? `${Math.round((event.used / event.size) * 100)}%` : "?";
          line(dim(`  ▦ context ${event.used}/${event.size > 0 ? event.size : "unknown"} (${pct})`));
          break;
        }
        case "agent_config": {
          if (event.options.length === 0 && event.modes === null) break;
          for (const option of event.options) {
            const where = option.category ? dim(` [${option.category}]`) : "";
            const choices =
              option.kind === "boolean"
                ? "on/off"
                : `${option.choices.length} choices`;
            line(dim(`  ⚙ ${option.id} = ${String(option.value)}${where} (${choices})`));
          }
          break;
        }
        case "text": {
          if (event.role === "user") {
            line(dim(`« ${event.text.trim()}`));
            break;
          }
          if (!streamingText || streamingThought !== event.thought) {
            if (streamingText) process.stdout.write("\n");
            process.stdout.write(`${stamp()}${event.thought ? dim("💭 ") : ""}`);
            streamingText = true;
            streamingThought = event.thought;
          }
          process.stdout.write(event.thought ? dim(event.text) : event.text);
          break;
        }
        case "tool_call": {
          const where = event.locations.map((l) => l.path).join(", ");
          parents.set(event.toolCallId, event.parentToolCallId);
          const pad = "  ".repeat(depthOf(event.toolCallId));
          const mark = event.subagent ? "🤖" : "🔧";
          line(
            `${pad}${mark} ${bold(event.title)} ${dim(`[${event.kind}] ${event.status}${where ? ` · ${where}` : ""}`)}`,
          );
          break;
        }
        case "tool_call_update": {
          const pad = "  ".repeat(depthOf(event.toolCallId));
          if (event.status) line(dim(`${pad}   ↳ ${event.status}${event.title ? ` · ${event.title}` : ""}`));
          // Clipped to a few lines: this is a progress view, not a terminal.
          for (const block of event.content ?? []) {
            for (const outLine of block.split("\n").slice(0, 6)) {
              if (outLine.length > 0) line(dim(`     ${outLine.slice(0, 160)}`));
            }
          }
          break;
        }
        case "file_change": {
          const removed = event.oldText === null ? 0 : event.oldText.split("\n").length;
          const added = event.newText.split("\n").length;
          line(`📝 ${bold(event.path)} ${dim(`+${added}/-${removed} via ${event.source}`)}`);
          break;
        }
        case "permission_request": {
          line(`🔐 ${bold(event.title)}`);
          for (const option of event.options) {
            const chosen = option.optionId === event.decision;
            line(
              `   ${chosen ? "→" : " "} ${option.optionId} ${dim(`(${option.kind}) ${option.name}`)}`,
            );
          }
          if (!event.decision) line(dim("   → cancelled (no allow option offered)"));
          break;
        }
        case "plan": {
          line(`🗒  plan (${event.entries.length} entries)`);
          for (const entry of event.entries) {
            line(dim(`   [${entry.status}] ${entry.content}`));
          }
          break;
        }
        case "turn_end": {
          stopReason = event.stopReason;
          const usage = event.usage
            ? ` · ${event.usage.inputTokens} in / ${event.usage.outputTokens} out`
            : "";
          line(`${bold("■ turn end")} ${event.stopReason}${dim(usage)}`);
          break;
        }
        case "agent_log": {
          if (showLogs) line(dim(`⋯ ${event.line}`));
          break;
        }
        case "other": {
          line(dim(`· ${event.sessionUpdate}`));
          break;
        }
        case "error": {
          line(`✗ ${event.message}`);
          break;
        }
      }
    },
    summary() {
      if (streamingText) process.stdout.write("\n");
      const parts = [...counts.entries()]
        .filter(([type]) => type !== "agent_log")
        .map(([type, count]) => `${type}=${count}`)
        .join(" ");
      process.stdout.write(dim(`\n${parts}${stopReason ? ` stop=${stopReason}` : ""}\n`));
    },
  };
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof AgentUnavailableError) {
      console.error(`\n${error.message}\n`);
    } else {
      console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
