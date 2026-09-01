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
      // `allowNegative` is what makes the documented `--no-logs` actually parse.
      // Without it `parseArgs` rejects the flag outright under `strict`, so the
      // one spelling the usage text has always advertised was the one spelling
      // that could not be used.
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
  // The built-ins only, and that is honest rather than a shortfall: this driver
  // builds a bare `Session` with no store, so there is no `plugins` table to read
  // a contributed harness out of and nothing that could resolve one.
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

  /*
   * A resolver that prints the question and declines it.
   *
   * Its presence is what declares `clientCapabilities.elicitation.form`, and that
   * is what stops claude's adapter putting `AskUserQuestion` into
   * `disallowedTools` — so without this line the tool is not in the model's
   * toolset and no measurement of it is possible from here at all.
   *
   * It **declines** rather than answering: `decline` is the action that means
   * "the person skipped", so the tool runs with empty answers and the turn
   * carries on, which is what a non-interactive driver wants. Answering would
   * mean inventing somebody's opinion.
   *
   * The form is printed as the projection rather than as the raw schema, because
   * the projection is what every other layer sees and the caps it applies are
   * exactly what wants measuring.
   */
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

  // Every notification exactly as the agent sent it, tagged so that
  // `--raw --json` stays one parseable NDJSON stream: a raw line is the only
  // one with a `_raw` key, and a normalized event never has one.
  //
  // This is the instrument for questions the normalized union cannot answer,
  // because answering them is what it is *for* — `_meta` is an agent-shaped
  // blob and `session.ts` projects a few fields out of it rather than carrying
  // it. Reading an adapter's `dist/` is not a substitute; the relay note
  // already records that inspection was not enough.
  //
  // Subscribed after `Session.start`, so anything the agent volunteers during
  // the handshake or `session/new` is not seen here. Everything inside a turn
  // is, which is what this exists for.
  const offRaw = values.raw
    ? session.onRawUpdate((notification) => {
        process.stdout.write(`${JSON.stringify({ _raw: notification })}\n`);
      })
    : () => {};

  // The controls never reach the event iterator below — `Session` holds them and
  // announces them out of band, because its queue only drains inside a turn.
  // Printing them here is what keeps this driver honest about the daemon's
  // actual behaviour: a change that broke the subscription would otherwise show
  // up first on somebody's phone.
  printer.print({ type: "agent_config", ...session.agentConfig });
  const offConfig = session.onConfigChanged((config) => {
    printer.print({ type: "agent_config", ...config });
  });

  // Context usage the same way, and for a stronger version of the same reason: it
  // is announced out of band *and* never enters the log at all, so this driver is
  // the only place outside a browser where a broken subscription is visible.
  // Read-once-then-subscribe, because between turns there is no next update.
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

/**
 * What the printers accept.
 *
 * Deliberately wider than `SessionEvent`: context usage is *not* a wire event and
 * must not be given a shape that suggests it is. It rides the snapshot on the real
 * daemon, and there is no snapshot here — so it is announced to this driver
 * directly, under a name (`context_usage`) that exists only in this file.
 */
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
  /**
   * Which call each call ran inside, built as events arrive.
   *
   * A parent that has not been seen renders at depth 0 rather than being held
   * back — the same degradation the browser makes, demonstrated here rather than
   * merely described, because the daemon deliberately never reorders or buffers
   * to build a tree.
   */
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
          // Printed as the percentage a client draws, because that is what the
          // registry's fan-out rule is keyed on — a driver reporting raw tokens
          // would show churn no client could ever see.
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
          // The output the daemon used to throw away. Clipped to a few lines here
          // because this is a progress view, not a terminal — but printed at all,
          // so "did the tool actually say anything" is answerable without a browser.
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
