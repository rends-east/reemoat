import { readFileSync } from "node:fs";
import { approvalCode, keyFingerprint } from "@reemoat/protocol";
import { DeviceNotApproved, MachineKeyChanged, ReemoatError, isUnreachable, reemoat, type ReemoatClient, type Task } from "./index.js";

// The one file in this package that prints. Exit codes are stable, so a script can branch on them.
const EXIT = { ok: 0, refused: 1, usage: 2, approval: 3, keyChanged: 4, unreachable: 5, waitTimeout: 6 } as const;

const USAGE = `usage: reemoat <command>

  machines                                      the machines this key reaches
  machines trust <machine> --fingerprint <fp>   accept the key the server now names for one
  task add --cwd <folder> --agent <agent> (--brief <text> | --brief-file <path|->)
           [--title <t>] [--key <k>] [--start] [--assignee nobody|agent|you]
           [--status ready|review|done | --column <id>] [--label <l>]... [--worktree auto|require|never] [--nickname <n>]
  task list | get <id|key> | history <id>
  task edit <id> [--title <t>] [--brief <text> | --brief-file <path|->] [--summary <s>] [--assignee <a>] [--agent <a>] [--cwd <f>] [--label <l>]...
  task start <id> [--agent <a>] [--cwd <f>]
  task move <id> (--to <column> | --exit <exit>) [--from <column>] [--stop]
  task comment <id> (<text> | --text-file <path|->)
  task rm <id>
  task wait <id> --until <status|column|phase>[,…] [--timeout <seconds>] [--interval <seconds>]
  board [--yaml] | board put <file|-> [--revision <n>]
  device | device export | device rebind

  --machine <m>   (or REEMOAT_MACHINE) the machine, by its id or name     --json   answers and errors as JSON on stdout

  REEMOAT_SERVER and REEMOAT_API_KEY are required. REEMOAT_AGENT names the default agent, REEMOAT_DEVICE_NAME what the
  machine's device list calls this one, REEMOAT_DEVICE_KEY a device key held as a CI secret, REEMOAT_MACHINE_KEY the
  machine's key ahead of first contact, REEMOAT_CLIENT_HOME where keys live. REEMOAT_URL reaches a daemon on this
  computer over loopback instead (with REEMOAT_TOKEN, or a token from the key). Quote a ~ in --cwd: the machine expands it.`;

class Usage extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["start", "stop", "json", "yaml", "help"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!;
    if (!arg.startsWith("--") || arg === "--" || arg === "-") {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, ["true"]);
      continue;
    }
    const value = inline ?? argv[++at];
    if (value === undefined) throw new Usage(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

function one(parsed: Parsed, name: string): string | undefined {
  const values = parsed.flags.get(name);
  return values === undefined ? undefined : values[values.length - 1];
}

function has(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name);
}

function readText(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function textOf(parsed: Parsed, inline: string, file: string): string | undefined {
  const given = one(parsed, inline);
  const path = one(parsed, file);
  if (given !== undefined && path !== undefined) throw new Usage(`--${inline} or --${file}, not both`);
  return path !== undefined ? readText(path) : given;
}

const json = { on: false };

function out(value: unknown, line: () => string): void {
  process.stdout.write(json.on ? `${JSON.stringify(value, null, 2)}\n` : `${line()}\n`);
}

function note(text: string): void {
  if (!json.on) process.stderr.write(`${text}\n`);
}

function taskLine(task: Task): string {
  return [task.id, task.status, task.column ?? "-", JSON.stringify(task.title)].join("  ");
}

function machineOf(parsed: Parsed): string {
  const machine = one(parsed, "machine") ?? process.env["REEMOAT_MACHINE"];
  if (machine === undefined || machine.length === 0) throw new Usage("name the machine with --machine, or REEMOAT_MACHINE");
  return machine;
}

function idOf(parsed: Parsed, at: number, what = "task"): string {
  const id = parsed.positional[at];
  if (id === undefined) throw new Usage(`name the ${what}`);
  return id;
}

async function connect(parsed: Parsed): Promise<ReemoatClient> {
  const env = process.env;
  const server = env["REEMOAT_SERVER"] ?? env["REEMOAT_CP_URL"];
  const apiKey = env["REEMOAT_API_KEY"] ?? env["REEMOAT_CP_KEY"];
  if (server === undefined || server.length === 0) throw new Usage("set REEMOAT_SERVER to the address you sign in at");
  if (apiKey === undefined || apiKey.length === 0) throw new Usage("set REEMOAT_API_KEY to a key made in the Reemoat app's settings");
  const machine = one(parsed, "machine") ?? env["REEMOAT_MACHINE"];
  const machineKey = env["REEMOAT_MACHINE_KEY"];
  return await reemoat({
    server,
    apiKey,
    ...(env["REEMOAT_CLIENT_HOME"] ? { home: env["REEMOAT_CLIENT_HOME"] } : {}),
    ...(env["REEMOAT_DEVICE_KEY"] ? { deviceKey: env["REEMOAT_DEVICE_KEY"] } : {}),
    ...(env["REEMOAT_DEVICE_NAME"] ? { deviceName: env["REEMOAT_DEVICE_NAME"] } : {}),
    ...(machineKey && machine ? { machineKeys: { [machine]: machineKey } } : {}),
    ...(env["REEMOAT_URL"] ? { localUrl: env["REEMOAT_URL"] } : {}),
    ...(env["REEMOAT_URL"] && env["REEMOAT_TOKEN"] ? { localToken: env["REEMOAT_TOKEN"] } : {}),
  });
}

async function run(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  json.on = has(parsed, "json");
  const [command, verb] = parsed.positional;
  if (command === undefined || has(parsed, "help")) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !has(parsed, "help") ? EXIT.usage : EXIT.ok;
  }

  const r = await connect(parsed);
  switch (command) {
    case "machines": {
      if (verb === "trust") {
        const fingerprint = one(parsed, "fingerprint");
        if (fingerprint === undefined) throw new Usage("--fingerprint is the one you compared with the machine's");
        const machine = idOf(parsed, 2, "machine");
        const trusted = await r.client.trust(machine, fingerprint);
        out({ machine, fingerprint: trusted }, () => `${machine} is now reached on ${trusted}`);
        return EXIT.ok;
      }
      const machines = await r.machines();
      out({ machines }, () =>
        machines
          .map((row) => [row.id, JSON.stringify(row.name), row.relayOnline ? "online" : "offline", row.key === null ? "no key" : fingerprint(row.key)].join("  "))
          .join("\n") || "(this key reaches no machine)",
      );
      return EXIT.ok;
    }
    case "task":
      return await task(r, parsed, verb);
    case "board": {
      const machine = machineOf(parsed);
      if (verb === "put") {
        const file = idOf(parsed, 2, "file with the board's YAML, or - for stdin");
        const revision = one(parsed, "revision");
        if (revision !== undefined && !/^\d+$/.test(revision)) throw new Usage("--revision is the number `reemoat board` printed");
        const put = await r.board.put(machine, readText(file), revision === undefined ? {} : { revision: Number(revision) });
        out(put, () => (put.changed ? `the board is at revision ${put.revision}` : `unchanged, at revision ${put.revision}`));
        return EXIT.ok;
      }
      const board = await r.board.get(machine);
      note(`revision ${board.revision}`);
      out(board, () => board.text.replace(/\n$/, ""));
      return EXIT.ok;
    }
    case "device": {
      if (verb === "rebind") {
        await r.client.rebind();
        out({ rebound: true }, () => "this API key is now bound to this installation's key; any other copy of it stops reaching machines");
        return EXIT.ok;
      }
      const device = verb === "export" ? r.client.localDevice() : await r.client.deviceKey();
      if (verb === "export") {
        out({ REEMOAT_DEVICE_KEY: device.secret }, () => `REEMOAT_DEVICE_KEY=${device.secret}`);
        note("keep it as a secret beside REEMOAT_API_KEY: whoever holds both is this device");
        return EXIT.ok;
      }
      const key = new Uint8Array(Buffer.from(device.publicKey, "base64url"));
      const shown = { publicKey: device.publicKey, approvalCode: approvalCode(key), fingerprint: keyFingerprint(key), apiKey: r.client.me.apiKey?.id ?? null };
      out(shown, () => `approval code  ${shown.approvalCode}\nfingerprint    ${shown.fingerprint}\nbound to       ${shown.apiKey ?? "this API key"}`);
      return EXIT.ok;
    }
    default:
      throw new Usage(`no command ${JSON.stringify(command)}`);
  }
}

async function task(r: ReemoatClient, parsed: Parsed, verb: string | undefined): Promise<number> {
  const machine = machineOf(parsed);
  switch (verb) {
    case "add": {
      const brief = textOf(parsed, "brief", "brief-file");
      const cwd = one(parsed, "cwd");
      const agent = one(parsed, "agent") ?? process.env["REEMOAT_AGENT"];
      if (brief === undefined || brief.trim().length === 0) throw new Usage("--brief is the agent's first message");
      if (cwd === undefined) throw new Usage("--cwd is the folder on the machine it runs in");
      if (agent === undefined) throw new Usage("--agent names who runs it (or REEMOAT_AGENT)");
      const worktree = one(parsed, "worktree");
      const assignee = one(parsed, "assignee");
      const status = one(parsed, "status");
      const made = await r.tasks.create(machine, {
        brief,
        cwd,
        agent,
        ...optional("title", one(parsed, "title")),
        ...optional("key", one(parsed, "key")),
        ...optional("column", one(parsed, "column")),
        ...optional("nickname", one(parsed, "nickname")),
        ...(assignee === undefined ? {} : { assignee: assignee as "nobody" | "agent" | "you" }),
        ...(status === undefined ? {} : { status: status as "ready" | "review" | "done" }),
        ...(worktree === undefined ? {} : { worktree: worktree as "auto" | "require" | "never" }),
        ...(parsed.flags.has("label") ? { labels: parsed.flags.get("label")! } : {}),
        ...(has(parsed, "start") ? { start: true } : {}),
      });
      if (made.existing) note(`already there (key ${String(made.task.key)})`);
      out(made, () => taskLine(made.task));
      return EXIT.ok;
    }
    case "list": {
      const listing = await r.tasks.listing(machine);
      out(listing, () => listing.tasks.map(taskLine).join("\n") || "(no tasks)");
      return EXIT.ok;
    }
    case "get": {
      const found = await r.tasks.get(machine, idOf(parsed, 2));
      out(found, () => `${taskLine(found)}${found.summary ? `\n${found.summary}` : ""}`);
      return EXIT.ok;
    }
    case "history": {
      const history = await r.tasks.history(machine, idOf(parsed, 2));
      out(history, () => JSON.stringify(history, null, 2));
      return EXIT.ok;
    }
    case "edit": {
      const brief = textOf(parsed, "brief", "brief-file");
      const change: Record<string, unknown> = {
        ...optional("title", one(parsed, "title")),
        ...optional("brief", brief),
        ...optional("summary", one(parsed, "summary")),
        ...optional("assignee", one(parsed, "assignee")),
        ...optional("agent", one(parsed, "agent")),
        ...optional("cwd", one(parsed, "cwd")),
        ...(parsed.flags.has("label") ? { labels: parsed.flags.get("label") } : {}),
      };
      if (Object.keys(change).length === 0) throw new Usage("say what to change");
      const edited = await r.tasks.update(machine, idOf(parsed, 2), change);
      out(edited, () => taskLine(edited));
      return EXIT.ok;
    }
    case "start": {
      const started = await r.tasks.start(machine, idOf(parsed, 2), { ...optional("agent", one(parsed, "agent")), ...optional("cwd", one(parsed, "cwd")) });
      out(started, () => taskLine(started.task));
      return EXIT.ok;
    }
    case "move": {
      const to = one(parsed, "to");
      const exit = one(parsed, "exit");
      if ((to === undefined) === (exit === undefined)) throw new Usage("name a column with --to, or an exit with --exit");
      const moved = await r.tasks.move(machine, idOf(parsed, 2), {
        ...optional("to", to),
        ...optional("exit", exit),
        ...optional("from", one(parsed, "from")),
        ...(has(parsed, "stop") ? { stop: true } : {}),
      });
      out(moved, () => taskLine(moved));
      return EXIT.ok;
    }
    case "comment": {
      const path = one(parsed, "text-file");
      const words = parsed.positional.slice(3).join(" ");
      const text = path !== undefined ? readText(path) : words;
      if (text.trim().length === 0) throw new Usage("say what the comment is");
      const answer = await r.tasks.comment(machine, idOf(parsed, 2), text);
      out(answer, () => "sent");
      return EXIT.ok;
    }
    case "rm": {
      const id = idOf(parsed, 2);
      await r.tasks.delete(machine, id);
      out({ deleted: id }, () => `deleted ${id}`);
      return EXIT.ok;
    }
    case "wait": {
      const until = one(parsed, "until");
      if (until === undefined) throw new Usage("--until names the statuses, columns or phases to wait for, comma-separated");
      const timeout = seconds(parsed, "timeout");
      const interval = seconds(parsed, "interval");
      try {
        const reached = await r.tasks.wait(machine, idOf(parsed, 2), {
          until: until.split(",").map((one) => one.trim()).filter((one) => one.length > 0),
          ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }),
          ...(interval === undefined ? {} : { intervalMs: interval * 1000 }),
        });
        if (reached.machine !== machine) note(`it is on ${reached.machine} now`);
        out(reached, () => taskLine(reached.task));
        return EXIT.ok;
      } catch (error) {
        if (error instanceof ReemoatError && error.code === "wait_timeout") {
          report(error);
          return EXIT.waitTimeout;
        }
        throw error;
      }
    }
    default:
      throw new Usage(verb === undefined ? "say what to do with tasks" : `no task command ${JSON.stringify(verb)}`);
  }
}

function optional<K extends string>(name: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [name]: value }) as { [P in K]?: string };
}

function seconds(parsed: Parsed, name: string): number | undefined {
  const value = one(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Usage(`--${name} is a number of seconds`);
  return Number(value);
}

function fingerprint(key: string): string {
  const bytes = new Uint8Array(Buffer.from(key, "base64url"));
  return bytes.length === 32 ? keyFingerprint(bytes) : "unreadable key";
}

function report(error: ReemoatError): void {
  if (json.on) {
    process.stdout.write(`${JSON.stringify(error.toJSON(), null, 2)}\n`);
    return;
  }
  process.stderr.write(`reemoat: ${error.message}\n`);
  if (error instanceof DeviceNotApproved) process.stderr.write(`  Approval code  ${error.approvalCode}\n`);
  if (error.remedy !== null) process.stderr.write(`  ${error.remedy}\n`);
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof Usage) {
    process.stderr.write(`reemoat: ${error.message}\n\n${USAGE}\n`);
    process.exitCode = EXIT.usage;
  } else if (error instanceof ReemoatError) {
    report(error);
    process.exitCode =
      error instanceof DeviceNotApproved ? EXIT.approval : error instanceof MachineKeyChanged ? EXIT.keyChanged : isUnreachable(error) ? EXIT.unreachable : EXIT.refused;
  } else {
    process.stderr.write(`reemoat: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.refused;
  }
}
