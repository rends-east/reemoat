// A board as its YAML says it, read by one pure function both the daemons and the app run.
import { isMap, isNode, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Node, type Pair, type YAMLMap } from "yaml";
import { parseTemplate, type Template } from "./template.js";
import { parseRules, type Rule } from "./rules.js";

export const BOARD_VERSION = 1;
export const MAX_BOARD_BYTES = 64 * 1024;
export const MAX_ROLES = 32;
export const MAX_COLUMNS = 32;
export const MAX_EXITS = 8;
export const MAX_DECIDE = 6;
export const MAX_ON_MACHINES = 16;
export const MAX_COLUMN_TITLE_CHARS = 40;
export const MAX_EXIT_LABEL_CHARS = 40;
export const MAX_EXIT_MEANS_CHARS = 500;
export const MAX_SKILL_ARGS_CHARS = 2_000;
export const MAX_PROMPT_CHARS = 16_000;
export const MAX_MODEL_CHARS = 128;
export const MAX_MACHINE_NAME_CHARS = 64;
export const MAX_COLUMN_LIMIT = 64;
export const DEFAULT_BUDGET = 8;
export const MIN_BUDGET = 1;
export const MAX_BUDGET = 50;

export const COLUMN_ID = /^[a-z0-9-]{1,32}$/;
export const EXIT_NAME = /^[a-z0-9_-]{1,32}$/;
export const ROLE_NAME = /^[a-z0-9_-]{1,32}$/;
export const SKILL_NAME = /^[a-z0-9:_-]{1,64}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,64}$/;

/** What a judge's answer may name besides an exit: leave the choice to the next judge's person. */
export const STAY = "stay";
/** The name a `next: <column>` shorthand's one exit goes by. */
export const SHORTHAND_EXIT = "next";
export const RESERVED_ROLES: readonly string[] = ["self", "human"];
export const SEES = ["brief", "summary", "report", "last_message", "diff_stat", "diff"] as const;
export type Sees = (typeof SEES)[number];
export const DEFAULT_SEES: readonly Sees[] = ["report", "last_message"];

/** Every key each level of a board takes: what parseBoard refuses an unknown field against, and what the guide documents. */
export const BOARD_FIELDS = {
  top: ["version", "intake", "budget", "roles", "columns"],
  role: ["agent", "model", "on", "min_confidence"],
  column: ["id", "title", "show", "run", "next", "decide", "sees", "holder", "limit", "final"],
  run: ["role", "skill", "args", "prompt", "conversation", "done_when"],
  exit: ["to", "means", "label"],
  judge: ["rules"],
} as const;

export interface Role {
  name: string;
  /** A harness, an assembled agent or a plugin's classifier, without the machine. */
  agent: string;
  model: string | null;
  /** Machines by preference, as named; null is every machine. */
  on: string[] | null;
  minConfidence: number | null;
}

export interface Exit {
  name: string;
  to: string;
  means: string | null;
  label: string;
}

export type Judge = { kind: "self" } | { kind: "human" } | { kind: "role"; role: string } | { kind: "rules"; rules: Rule[] };

export interface Run {
  /** null is the task's own agent, else the role called `default`. */
  role: string | null;
  skill: string | null;
  args: string | null;
  prompt: Template | null;
  conversation: "continue" | "new";
  doneWhen: "report" | "turn";
}

interface ColumnBase {
  id: string;
  title: string;
}

export interface ViewColumn extends ColumnBase {
  kind: "view";
  show: "sessions";
}

export interface WaitColumn extends ColumnBase {
  kind: "wait";
  exits: Exit[];
  decide: Judge[];
  sees: Sees[];
  holder: "you" | "nobody";
  final: boolean;
}

export interface WorkColumn extends ColumnBase {
  kind: "work";
  run: Run;
  exits: Exit[];
  decide: Judge[];
  sees: Sees[];
  limit: number | null;
}

export type Column = ViewColumn | WaitColumn | WorkColumn;
export type FlowColumn = WaitColumn | WorkColumn;

export interface Board {
  version: 1;
  intake: string;
  budget: number;
  roles: Role[];
  columns: Column[];
}

export interface BoardError {
  line: number;
  col: number;
  path: string;
  message: string;
}

export type ParsedBoard = { ok: true; board: Board } | { ok: false; errors: BoardError[] };

export function formatBoardError(error: BoardError): string {
  return `${error.line}:${error.col} ${error.path.length === 0 ? "board" : error.path}: ${error.message}`;
}

export function columnById(board: Board, id: string): Column | null {
  return board.columns.find((column) => column.id === id) ?? null;
}

export function roleByName(board: Board, name: string): Role | null {
  return board.roles.find((role) => role.name === name) ?? null;
}

export function isFlow(column: Column | null): column is FlowColumn {
  return column !== null && column.kind !== "view";
}

export function viewColumn(board: Board): ViewColumn | null {
  return board.columns.find((column): column is ViewColumn => column.kind === "view") ?? null;
}

/** Where a role's agent and its machines part: `claude@server` is `claude` on `server`. */
export function splitAgentRef(value: string): { agent: string; machine: string | null } {
  const at = value.lastIndexOf("@");
  return at <= 0 ? { agent: value, machine: null } : { agent: value.slice(0, at), machine: value.slice(at + 1) };
}

/** The board, or every refusal at once, each with its line, column and path. Never throws. */
export function parseBoard(text: string): ParsedBoard {
  const errors: BoardError[] = [];
  const lines = new LineCounter();
  const at = (offset: number | undefined): { line: number; col: number } => {
    const pos = lines.linePos(offset ?? 0);
    return { line: pos.line, col: pos.col };
  };
  const refuse = (node: unknown, path: string, message: string): void => {
    const offset = rangeOf(node);
    errors.push({ ...at(offset), path, message });
  };

  if (new TextEncoder().encode(text).length > MAX_BOARD_BYTES) {
    return { ok: false, errors: [{ line: 1, col: 1, path: "", message: `a board is at most ${MAX_BOARD_BYTES / 1024} KiB` }] };
  }
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true, strict: true, schema: "core", version: "1.2", prettyErrors: false });
  for (const problem of doc.errors) {
    errors.push({ ...at(problem.pos[0]), path: "", message: syntaxWords(problem.code, problem.message) });
  }
  // The core schema turns `!!binary` into a Buffer by itself, so a tag is refused before anything reads a value.
  visit(doc, {
    Alias(_key, node, ancestors) {
      refuse(node, pathOf(ancestors, node), "aliases are not allowed; write the value out");
    },
    Node(_key, node, ancestors) {
      if (node.anchor !== undefined) refuse(node, pathOf(ancestors, node), "anchors are not allowed; write the value out");
      if (node.tag !== undefined) refuse(node, pathOf(ancestors, node), `tags are not allowed (${node.tag.replace(/^tag:yaml\.org,2002:/, "!!")})`);
    },
  });
  if (errors.length > 0) return { ok: false, errors: sorted(errors) };

  const root = doc.contents;
  if (!isMap(root)) {
    refuse(root, "", "a board is a map with version and columns");
    return { ok: false, errors: sorted(errors) };
  }
  const top = fields(root, "", BOARD_FIELDS.top, refuse);

  const version = top.get("version");
  if (version === undefined) refuse(root, "version", "version is required; write version: 1");
  else if (!isScalar(version.value) || version.value.value !== BOARD_VERSION) {
    refuse(version.value, "version", `this build reads version ${BOARD_VERSION}`);
  }

  let budget = DEFAULT_BUDGET;
  const budgetPair = top.get("budget");
  if (budgetPair !== undefined) {
    const value = intOf(budgetPair.value);
    if (value === null || value < MIN_BUDGET || value > MAX_BUDGET) {
      refuse(budgetPair.value, "budget", `budget is a whole number from ${MIN_BUDGET} to ${MAX_BUDGET}`);
    } else budget = value;
  }

  const roles = readRoles(top.get("roles"), refuse);
  const columns = readColumns(top.get("columns"), root, roles, refuse);

  let intake: string | null = columns.find((column) => column.kind !== "view")?.id ?? null;
  const intakePair = top.get("intake");
  if (intakePair !== undefined) {
    const id = stringOf(intakePair.value);
    const target = id === null ? null : (columns.find((column) => column.id === id) ?? null);
    if (id === null) refuse(intakePair.value, "intake", "intake is a column id");
    else if (target === null) refuse(intakePair.value, "intake", `there is no column ${JSON.stringify(id)}`);
    else if (target.kind === "view") refuse(intakePair.value, "intake", "a view column cannot take new tasks");
    else intake = id;
  }

  if (errors.length > 0 || intake === null) return { ok: false, errors: sorted(errors) };
  // A shorthand exit is pressed as the column it leads to.
  for (const column of columns) {
    if (column.kind === "view") continue;
    for (const exit of column.exits) if (exit.label === "") exit.label = columns.find((one) => one.id === exit.to)?.title ?? exit.to;
  }
  return { ok: true, board: { version: BOARD_VERSION, intake, budget, roles, columns } };
}

type Refuse = (node: unknown, path: string, message: string) => void;

function sorted(errors: BoardError[]): BoardError[] {
  return errors.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** `columns[2].title`, from the visitor's ancestors: a pair adds its key, a list the item's place in it. */
function pathOf(ancestors: readonly unknown[], node: unknown): string {
  const chain = [...ancestors, node];
  let out = "";
  for (const [index, one] of chain.entries()) {
    if (isPair(one) && isScalar(one.key)) out = join(out, String(one.key.value));
    else if (isSeq(one)) {
      const child = chain[index + 1];
      if (child !== undefined) out += `[${one.items.indexOf(child as never)}]`;
    }
  }
  return out;
}

function rangeOf(node: unknown): number | undefined {
  if (isPair(node)) return rangeOf(isNode(node.key) ? node.key : node.value);
  return isNode(node) ? node.range?.[0] : undefined;
}

function syntaxWords(code: string, message: string): string {
  if (code === "DUPLICATE_KEY") return "a key is written twice";
  if (code === "MULTIPLE_DOCS") return "a board is one document; remove the ---";
  return message.split("\n")[0]!.replace(/\.$/, "");
}

/** A map's pairs by key, refusing a key that is not a string and one this level does not know. */
function fields(map: YAMLMap, path: string, known: readonly string[], refuse: Refuse): Map<string, Pair> {
  const out = new Map<string, Pair>();
  for (const pair of map.items) {
    const key = isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : null;
    if (key === null) {
      refuse(pair, path, "keys are words");
      continue;
    }
    if (!known.includes(key)) {
      refuse(pair, join(path, key), `unknown field; this level takes ${known.join(", ")}`);
      continue;
    }
    out.set(key, pair as Pair);
  }
  return out;
}

function join(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

function stringOf(node: unknown): string | null {
  return isScalar(node) && typeof node.value === "string" ? node.value : null;
}

function intOf(node: unknown): number | null {
  return isScalar(node) && typeof node.value === "number" && Number.isInteger(node.value) ? node.value : null;
}

function oneLine(value: string | null, max: number): boolean {
  return value !== null && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);
}

function readRoles(pair: Pair | undefined, refuse: Refuse): Role[] {
  if (pair === undefined || (isScalar(pair.value) && pair.value.value === null)) return [];
  const map = pair.value;
  if (!isMap(map)) {
    refuse(map as Node, "roles", "roles is a map of name to role");
    return [];
  }
  if (map.items.length > MAX_ROLES) refuse(map, "roles", `at most ${MAX_ROLES} roles`);
  const roles: Role[] = [];
  for (const item of map.items) {
    const name = isScalar(item.key) && typeof item.key.value === "string" ? item.key.value : null;
    const path = `roles.${name ?? "?"}`;
    if (name === null || !ROLE_NAME.test(name)) {
      refuse(item, path, "a role's name is 1 to 32 of a-z, 0-9, _ and -");
      continue;
    }
    if (RESERVED_ROLES.includes(name)) {
      refuse(item, path, `${name} is a judge of its own; name the role something else`);
      continue;
    }
    const role = readRole(item.value as Node | null, path, name, refuse);
    if (role !== null) roles.push(role);
  }
  return roles;
}

function readRole(node: Node | null, path: string, name: string, refuse: Refuse): Role | null {
  if (!isMap(node)) {
    refuse(node, path, "a role is a map with at least agent");
    return null;
  }
  const f = fields(node, path, BOARD_FIELDS.role, refuse);
  const agentPair = f.get("agent");
  const raw = agentPair === undefined ? null : stringOf(agentPair.value);
  if (agentPair === undefined) {
    refuse(node, join(path, "agent"), "agent is required: a harness, an assembled agent or a classifier");
    return null;
  }
  if (raw === null) {
    refuse(agentPair.value as Node, join(path, "agent"), "agent is a name such as claude or claude@server");
    return null;
  }
  const { agent, machine } = splitAgentRef(raw.trim());
  if (!AGENT_ID.test(agent)) {
    refuse(agentPair.value as Node, join(path, "agent"), `${JSON.stringify(agent)} is not an agent's name`);
    return null;
  }
  if (machine !== null && !oneLine(machine, MAX_MACHINE_NAME_CHARS)) {
    refuse(agentPair.value as Node, join(path, "agent"), "the machine after @ is its name, one line");
    return null;
  }

  let on: string[] | null = machine === null ? null : [machine.trim()];
  const onPair = f.get("on");
  if (onPair !== undefined) {
    if (machine !== null) refuse(onPair, join(path, "on"), `write the machine once: either ${agent}@${machine} or on`);
    const list = isSeq(onPair.value) ? onPair.value.items : [onPair.value];
    const names: string[] = [];
    for (const [index, one] of list.entries()) {
      const value = stringOf(one);
      const where = isSeq(onPair.value) ? `${join(path, "on")}[${index}]` : join(path, "on");
      if (!oneLine(value, MAX_MACHINE_NAME_CHARS)) refuse(one as Node, where, "a machine is its name, one line");
      else if (names.some((held) => held.toLowerCase() === value!.trim().toLowerCase())) refuse(one as Node, where, "this machine is named twice");
      else names.push(value!.trim());
    }
    if (list.length === 0) refuse(onPair.value as Node, join(path, "on"), "name at least one machine, or leave on out");
    if (list.length > MAX_ON_MACHINES) refuse(onPair.value as Node, join(path, "on"), `at most ${MAX_ON_MACHINES} machines`);
    if (machine === null) on = names;
  }

  let model: string | null = null;
  const modelPair = f.get("model");
  if (modelPair !== undefined) {
    model = stringOf(modelPair.value);
    if (model === null && isScalar(modelPair.value) && typeof modelPair.value.value === "number") model = String(modelPair.value.value);
    if (!oneLine(model, MAX_MODEL_CHARS)) {
      refuse(modelPair.value as Node, join(path, "model"), `model is a name of at most ${MAX_MODEL_CHARS} characters`);
      model = null;
    } else model = model!.trim();
  }

  let minConfidence: number | null = null;
  const confidencePair = f.get("min_confidence");
  if (confidencePair !== undefined) {
    const value = isScalar(confidencePair.value) && typeof confidencePair.value.value === "number" ? confidencePair.value.value : null;
    if (value === null || !(value >= 0 && value <= 1)) refuse(confidencePair.value as Node, join(path, "min_confidence"), "min_confidence is a number from 0 to 1");
    else minConfidence = value;
  }
  return { name, agent, model, on, minConfidence };
}

interface ColumnDraft {
  node: YAMLMap;
  path: string;
  f: Map<string, Pair>;
  id: string;
  title: string;
}

function readColumns(pair: Pair | undefined, root: YAMLMap, roles: Role[], refuse: Refuse): Column[] {
  if (pair === undefined) {
    refuse(root, "columns", `columns is required: a list of 1 to ${MAX_COLUMNS} columns`);
    return [];
  }
  const list = pair.value;
  if (!isSeq(list) || list.items.length === 0) {
    refuse(list as Node, "columns", `columns is a list of 1 to ${MAX_COLUMNS} columns`);
    return [];
  }
  if (list.items.length > MAX_COLUMNS) refuse(list, "columns", `at most ${MAX_COLUMNS} columns`);

  // Ids first, so an exit can name a column further down.
  const drafts: (ColumnDraft | null)[] = list.items.map((item, index) => {
    const path = `columns[${index}]`;
    if (!isMap(item)) {
      refuse(item as Node, path, "a column is a map with id and title");
      return null;
    }
    const f = fields(item, path, BOARD_FIELDS.column, refuse);
    const idPair = f.get("id");
    const id = idPair === undefined ? null : stringOf(idPair.value);
    if (idPair === undefined) refuse(item, join(path, "id"), "id is required");
    else if (id === null || !COLUMN_ID.test(id)) refuse(idPair.value as Node, join(path, "id"), "an id is 1 to 32 of a-z, 0-9 and -");
    const titlePair = f.get("title");
    const title = titlePair === undefined ? null : stringOf(titlePair.value) ?? (isScalar(titlePair.value) && titlePair.value.value !== null ? String(titlePair.value.value) : null);
    if (titlePair === undefined) refuse(item, join(path, "title"), "title is required");
    else if (!oneLine(title, MAX_COLUMN_TITLE_CHARS)) refuse(titlePair.value as Node, join(path, "title"), `a title is one line of at most ${MAX_COLUMN_TITLE_CHARS} characters`);
    if (id === null || !COLUMN_ID.test(id) || !oneLine(title, MAX_COLUMN_TITLE_CHARS)) return null;
    return { node: item, path, f, id, title: title!.trim() };
  });

  const seen = new Set<string>();
  for (const draft of drafts) {
    if (draft === null) continue;
    if (seen.has(draft.id)) refuse(draft.f.get("id")!.value as Node, join(draft.path, "id"), `another column is already ${JSON.stringify(draft.id)}`);
    seen.add(draft.id);
  }

  const views = drafts.filter((draft) => draft?.f.has("show"));
  const viewIds = new Set(views.map((draft) => draft!.id));
  const ids = new Set(drafts.filter((draft): draft is ColumnDraft => draft !== null).map((draft) => draft.id));
  const columns: Column[] = [];
  let viewSeen = false;
  for (const draft of drafts) {
    if (draft === null) continue;
    const column = readColumn(draft, ids, viewIds, roles, refuse);
    if (column === null) continue;
    if (column.kind === "view") {
      if (viewSeen) refuse(draft.f.get("show")!, join(draft.path, "show"), "a board has at most one view of sessions");
      viewSeen = true;
    }
    columns.push(column);
  }
  if (drafts.every((draft) => draft !== null && draft.f.has("show"))) {
    refuse(list, "columns", "a board needs a column a task can stand in, not only a view");
  }
  return columns;
}

function readColumn(draft: ColumnDraft, ids: Set<string>, viewIds: Set<string>, roles: Role[], refuse: Refuse): Column | null {
  const { f, path, id, title } = draft;
  const showPair = f.get("show");
  if (showPair !== undefined) {
    if (stringOf(showPair.value) !== "sessions") refuse(showPair.value as Node, join(path, "show"), "show takes sessions");
    for (const [key, pair] of f) {
      if (key !== "id" && key !== "title" && key !== "show") refuse(pair, join(path, key), "a view of sessions takes id and title alone");
    }
    return { kind: "view", id, title, show: "sessions" };
  }

  const runPair = f.get("run");
  const run = runPair === undefined ? null : readRun(runPair, join(path, "run"), roles, refuse);
  const working = runPair !== undefined;
  const exitNodes = new Map<string, unknown>();
  const exits = readExits(f.get("next"), join(path, "next"), ids, viewIds, exitNodes, refuse);
  const decide = readDecide(f.get("decide"), join(path, "decide"), working, roles, exits, ids, refuse);

  let sees: Sees[] = [...DEFAULT_SEES];
  const seesPair = f.get("sees");
  if (seesPair !== undefined) {
    sees = [];
    const list = isSeq(seesPair.value) ? seesPair.value.items : null;
    if (list === null) refuse(seesPair.value as Node, join(path, "sees"), `sees is a list of ${SEES.join(", ")}`);
    for (const [index, one] of (list ?? []).entries()) {
      const value = stringOf(one);
      if (value === null || !(SEES as readonly string[]).includes(value)) {
        refuse(one as Node, `${join(path, "sees")}[${index}]`, `sees takes ${SEES.join(", ")}`);
      } else if (sees.includes(value as Sees)) refuse(one as Node, `${join(path, "sees")}[${index}]`, "named twice");
      else sees.push(value as Sees);
    }
  }

  // Every exit a person-less judge picks between says what it means, or the judge is guessing.
  const judged = working ? exits.length >= 2 : exits.length >= 1;
  if (judged && decide.some((judge) => judge.kind === "self" || judge.kind === "role")) {
    for (const exit of exits) {
      if (exit.means === null) {
        refuse(exitNodes.get(exit.name), `${join(path, "next")}.${exit.name}`, "means is required: say when this exit is the right one, for the agent or role that picks it");
      }
    }
  }

  if (working) {
    for (const key of ["holder", "final"]) {
      if (f.has(key)) refuse(f.get(key)!, join(path, key), `${key} is for a column without run`);
    }
    let limit: number | null = null;
    const limitPair = f.get("limit");
    if (limitPair !== undefined) {
      limit = intOf(limitPair.value);
      if (limit === null || limit < 1 || limit > MAX_COLUMN_LIMIT) {
        refuse(limitPair.value as Node, join(path, "limit"), `limit is a whole number from 1 to ${MAX_COLUMN_LIMIT}`);
        limit = null;
      }
    }
    if (run === null) return null;
    return { kind: "work", id, title, run, exits, decide, sees, limit };
  }

  if (f.has("limit")) refuse(f.get("limit")!, join(path, "limit"), "limit is for a column with run");
  let holder: "you" | "nobody" = "nobody";
  const holderPair = f.get("holder");
  if (holderPair !== undefined) {
    const value = stringOf(holderPair.value);
    if (value !== "you" && value !== "nobody") refuse(holderPair.value as Node, join(path, "holder"), "holder is you or nobody");
    else holder = value;
  }
  let final = false;
  const finalPair = f.get("final");
  if (finalPair !== undefined) {
    if (!isScalar(finalPair.value) || typeof finalPair.value.value !== "boolean") refuse(finalPair.value as Node, join(path, "final"), "final is true or false");
    else final = finalPair.value.value;
  }
  return { kind: "wait", id, title, exits, decide, sees, holder, final };
}

function readRun(pair: Pair, path: string, roles: Role[], refuse: Refuse): Run | null {
  const node = pair.value;
  const empty = isScalar(node) && node.value === null;
  if (!empty && !isMap(node)) {
    refuse(node as Node, path, "run is a map; write run: {} for the task's own agent");
    return null;
  }
  const f = empty ? new Map<string, Pair>() : fields(node as YAMLMap, path, BOARD_FIELDS.run, refuse);
  let ok = true;
  const run: Run = { role: null, skill: null, args: null, prompt: null, conversation: "continue", doneWhen: "report" };

  const rolePair = f.get("role");
  if (rolePair !== undefined) {
    const name = stringOf(rolePair.value);
    if (name === null || roles.every((role) => role.name !== name)) {
      refuse(rolePair.value as Node, join(path, "role"), name === null ? "role names a role" : `there is no role ${JSON.stringify(name)}`);
      ok = false;
    } else run.role = name;
  }

  const skillPair = f.get("skill");
  if (skillPair !== undefined) {
    const skill = stringOf(skillPair.value);
    if (skill === null || !SKILL_NAME.test(skill.replace(/^\//, ""))) {
      refuse(skillPair.value as Node, join(path, "skill"), "a skill is 1 to 64 of a-z, 0-9, :, _ and -, sent as /<skill>");
      ok = false;
    } else run.skill = skill.replace(/^\//, "");
  }

  const argsPair = f.get("args");
  if (argsPair !== undefined) {
    const args = stringOf(argsPair.value);
    if (skillPair === undefined) refuse(argsPair, join(path, "args"), "args go with a skill");
    if (args === null || args.length > MAX_SKILL_ARGS_CHARS || args.includes("\0")) {
      refuse(argsPair.value as Node, join(path, "args"), `args are text of at most ${MAX_SKILL_ARGS_CHARS} characters`);
      ok = false;
    } else run.args = args.trim().length === 0 ? null : args.trim();
  }

  const promptPair = f.get("prompt");
  if (promptPair !== undefined) {
    if (skillPair !== undefined) refuse(promptPair, join(path, "prompt"), "a run sends a skill or a prompt, not both");
    const text = stringOf(promptPair.value);
    if (text === null || text.trim().length === 0 || text.length > MAX_PROMPT_CHARS || text.includes("\0")) {
      refuse(promptPair.value as Node, join(path, "prompt"), `prompt is text of 1 to ${MAX_PROMPT_CHARS} characters`);
      ok = false;
    } else {
      const template = parseTemplate(text);
      if (typeof template === "string") {
        refuse(promptPair.value as Node, join(path, "prompt"), template);
        ok = false;
      } else run.prompt = template;
    }
  }

  const conversationPair = f.get("conversation");
  if (conversationPair !== undefined) {
    const value = stringOf(conversationPair.value);
    if (value !== "continue" && value !== "new") {
      refuse(conversationPair.value as Node, join(path, "conversation"), "conversation is continue or new");
      ok = false;
    } else run.conversation = value;
  }

  const donePair = f.get("done_when");
  if (donePair !== undefined) {
    const value = stringOf(donePair.value);
    if (value !== "report" && value !== "turn") {
      refuse(donePair.value as Node, join(path, "done_when"), "done_when is report or turn");
      ok = false;
    } else run.doneWhen = value;
  }
  return ok ? run : null;
}

function readExits(
  pair: Pair | undefined,
  path: string,
  ids: Set<string>,
  viewIds: Set<string>,
  nodes: Map<string, unknown>,
  refuse: Refuse,
): Exit[] {
  if (pair === undefined) return [];
  const target = (node: unknown, where: string): string | null => {
    const id = stringOf(node);
    if (id === null) refuse(node as Node, where, "an exit leads to a column id");
    else if (!ids.has(id)) refuse(node as Node, where, `there is no column ${JSON.stringify(id)}`);
    else if (viewIds.has(id)) refuse(node as Node, where, "a view of sessions holds no tasks");
    else return id;
    return null;
  };

  if (!isMap(pair.value)) {
    const to = target(pair.value, path);
    nodes.set(SHORTHAND_EXIT, pair.value);
    return to === null ? [] : [{ name: SHORTHAND_EXIT, to, means: null, label: "" }];
  }
  const map = pair.value;
  if (map.items.length === 0) refuse(map, path, "name at least one exit, or leave next out");
  if (map.items.length > MAX_EXITS) refuse(map, path, `at most ${MAX_EXITS} exits`);
  const exits: Exit[] = [];
  for (const item of map.items) {
    const name = isScalar(item.key) && typeof item.key.value === "string" ? item.key.value : null;
    const where = `${path}.${name ?? "?"}`;
    if (name === null || !EXIT_NAME.test(name)) {
      refuse(item, where, "an exit's name is 1 to 32 of a-z, 0-9, _ and -");
      continue;
    }
    if (name === STAY) {
      refuse(item, where, "stay is what a judge answers to leave the choice to the next one; name the exit something else");
      continue;
    }
    const value = item.value as Node | null;
    nodes.set(name, item);
    if (!isMap(value)) {
      const to = target(value, where);
      if (to !== null) exits.push({ name, to, means: null, label: name });
      continue;
    }
    const f = fields(value, where, BOARD_FIELDS.exit, refuse);
    const toPair = f.get("to");
    if (toPair === undefined) {
      refuse(value, `${where}.to`, "to is required: the column this exit leads to");
      continue;
    }
    const to = target(toPair.value, `${where}.to`);
    let means: string | null = null;
    const meansPair = f.get("means");
    if (meansPair !== undefined) {
      means = stringOf(meansPair.value);
      if (means === null || means.trim().length === 0 || means.length > MAX_EXIT_MEANS_CHARS) {
        refuse(meansPair.value as Node, `${where}.means`, `means is text of 1 to ${MAX_EXIT_MEANS_CHARS} characters`);
        means = null;
      } else means = means.trim();
    }
    let label = name;
    const labelPair = f.get("label");
    if (labelPair !== undefined) {
      const value = stringOf(labelPair.value);
      if (!oneLine(value, MAX_EXIT_LABEL_CHARS)) refuse(labelPair.value as Node, `${where}.label`, `a label is one line of at most ${MAX_EXIT_LABEL_CHARS} characters`);
      else label = value!.trim();
    }
    if (to !== null) exits.push({ name, to, means, label });
  }
  return exits;
}

function readDecide(
  pair: Pair | undefined,
  path: string,
  working: boolean,
  roles: Role[],
  exits: Exit[],
  ids: ReadonlySet<string>,
  refuse: Refuse,
): Judge[] {
  if (pair === undefined) return working ? [{ kind: "self" }, { kind: "human" }] : [{ kind: "human" }];
  const list = isSeq(pair.value) ? pair.value.items : null;
  if (list === null) {
    refuse(pair.value as Node, path, "decide is a list of self, human, role names and {rules: [...]}");
    return working ? [{ kind: "self" }, { kind: "human" }] : [{ kind: "human" }];
  }
  if (list.length === 0) refuse(pair.value as Node, path, "name at least one judge, or leave decide out");
  if (list.length > MAX_DECIDE) refuse(pair.value as Node, path, `at most ${MAX_DECIDE} judges`);
  const judges: Judge[] = [];
  const named = new Set<string>();
  for (const [index, one] of list.entries()) {
    const where = `${path}[${index}]`;
    if (judges.some((judge) => judge.kind === "human")) {
      refuse(one as Node, where, "nothing after human is ever asked: human waits");
      break;
    }
    if (isMap(one)) {
      if (!one.items.some((item) => isScalar(item.key) && item.key.value === "rules")) {
        refuse(one, where, "a map in decide is {rules: [...]}");
        continue;
      }
      const rulesPair = fields(one, where, BOARD_FIELDS.judge, refuse).get("rules")!;
      const rules = parseRules(rulesPair.value as Node | null, `${where}.rules`, exits, ids, refuse);
      if (rules !== null) judges.push({ kind: "rules", rules });
      continue;
    }
    const name = stringOf(one);
    if (name === null) {
      refuse(one as Node, where, "a judge is self, human, a role's name or {rules: [...]}");
      continue;
    }
    if (named.has(name)) {
      refuse(one as Node, where, `${name} is asked twice`);
      continue;
    }
    named.add(name);
    if (name === "self") {
      if (!working) refuse(one as Node, where, "self is the agent of this column's run, and this column has no run");
      else judges.push({ kind: "self" });
    } else if (name === "human") judges.push({ kind: "human" });
    else if (roles.some((role) => role.name === name)) judges.push({ kind: "role", role: name });
    else refuse(one as Node, where, `there is no role ${JSON.stringify(name)}`);
  }
  if (!judges.some((judge) => judge.kind === "human")) judges.push({ kind: "human" });
  return judges;
}
