// A judge that is a list of rules: the first whose every condition holds names the exit.
import { isMap, isScalar, isSeq, type Node, type Pair } from "yaml";
import type { Exit } from "./config.js";

export const MAX_RULES = 16;
const MAX_RULE_LIST = 32;
const MAX_RULE_TEXT = 200;

type FactType = "number" | "string" | "list";
export const RULE_FACTS: Readonly<Record<string, FactType>> = {
  outcome: "string",
  labels: "list",
  "diff.files": "number",
  "diff.lines": "number",
  "diff.paths": "list",
  agent: "string",
  project: "string",
};
const VISITS = /^visits\.([a-z0-9-]{1,32})$/;
const OPERATORS: Readonly<Record<FactType, readonly string[]>> = {
  number: ["eq", "in", "gte", "lte"],
  string: ["eq", "in", "match"],
  list: ["has", "match"],
};

export type Condition =
  | { fact: string; op: "eq"; value: string | number }
  | { fact: string; op: "in"; value: (string | number)[] }
  | { fact: string; op: "gte" | "lte"; value: number }
  | { fact: string; op: "has" | "match"; value: string };

export interface Rule {
  when: Condition[];
  /** An exit's name, or stay. */
  then: string;
}

export interface RuleFacts {
  outcome: string | null;
  labels: readonly string[];
  visits: Readonly<Record<string, number>>;
  /** null where the project is not a git repository, and every diff condition is then false. */
  diff: { files: number; lines: number; paths: readonly string[] } | null;
  agent: string | null;
  project: string | null;
}

type Refuse = (node: unknown, path: string, message: string) => void;

export function parseRules(node: Node | null, path: string, exits: readonly Exit[], columns: ReadonlySet<string>, refuse: Refuse): Rule[] | null {
  if (!isSeq(node) || node.items.length === 0) {
    refuse(node, path, "rules is a list of {when: {...}, then: <exit>}");
    return null;
  }
  if (node.items.length > MAX_RULES) refuse(node, path, `at most ${MAX_RULES} rules`);
  const rules: Rule[] = [];
  let ok = true;
  for (const [index, item] of node.items.entries()) {
    const where = `${path}[${index}]`;
    if (!isMap(item)) {
      refuse(item as Node, where, "a rule is {when: {...}, then: <exit>}");
      ok = false;
      continue;
    }
    const rule: Rule = { when: [], then: "" };
    for (const pair of item.items) {
      const key = isScalar(pair.key) ? pair.key.value : null;
      if (key === "then") {
        const then = isScalar(pair.value) && typeof pair.value.value === "string" ? pair.value.value : null;
        if (then === null || (then !== "stay" && !exits.some((exit) => exit.name === then))) {
          refuse(pair.value as Node, `${where}.then`, `then names an exit of this column (${[...exits.map((exit) => exit.name), "stay"].join(", ")})`);
          ok = false;
        } else rule.then = then;
      } else if (key === "when") {
        const conditions = parseWhen(pair.value as Node | null, `${where}.when`, columns, refuse);
        if (conditions === null) ok = false;
        else rule.when = conditions;
      } else {
        refuse(pair as Pair, `${where}.${String(key)}`, "a rule takes when and then");
        ok = false;
      }
    }
    if (rule.then === "" && item.items.every((pair) => !(isScalar(pair.key) && pair.key.value === "then"))) {
      refuse(item, `${where}.then`, "then is required");
      ok = false;
    }
    rules.push(rule);
  }
  return ok ? rules : null;
}

function parseWhen(node: Node | null, path: string, columns: ReadonlySet<string>, refuse: Refuse): Condition[] | null {
  if (!isMap(node)) {
    refuse(node, path, "when is a map of fact to {operator: value}");
    return null;
  }
  const out: Condition[] = [];
  let ok = true;
  for (const pair of node.items) {
    const fact = isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : null;
    const where = `${path}.${fact ?? "?"}`;
    const visits = fact === null ? null : VISITS.exec(fact);
    const type: FactType | undefined = fact === null ? undefined : visits !== null ? "number" : RULE_FACTS[fact];
    if (fact === null || type === undefined) {
      refuse(pair as Pair, where, `a fact is one of ${[...Object.keys(RULE_FACTS), "visits.<column>"].join(", ")}`);
      ok = false;
      continue;
    }
    if (visits !== null && !columns.has(visits[1]!)) {
      refuse(pair as Pair, where, `there is no column ${JSON.stringify(visits[1])}`);
      ok = false;
      continue;
    }
    const ops = pair.value;
    if (!isMap(ops) || ops.items.length === 0) {
      refuse(ops as Node, where, `a condition is {operator: value}; ${fact} takes ${OPERATORS[type].join(", ")}`);
      ok = false;
      continue;
    }
    for (const opPair of ops.items) {
      const op = isScalar(opPair.key) && typeof opPair.key.value === "string" ? opPair.key.value : null;
      const at = `${where}.${op ?? "?"}`;
      if (op === null || !OPERATORS[type].includes(op)) {
        refuse(opPair as Pair, at, `${fact} takes ${OPERATORS[type].join(", ")}`);
        ok = false;
        continue;
      }
      const condition = conditionOf(fact, op, opPair.value, type);
      if (typeof condition === "string") {
        refuse(opPair.value as Node, at, condition);
        ok = false;
      } else out.push(condition);
    }
  }
  return ok ? out : null;
}

function scalarOf(node: unknown, type: FactType): string | number | null {
  if (!isScalar(node)) return null;
  if (type === "number") return typeof node.value === "number" && Number.isFinite(node.value) ? node.value : null;
  if (typeof node.value === "string" && node.value.length > 0 && node.value.length <= MAX_RULE_TEXT) return node.value;
  return null;
}

function conditionOf(fact: string, op: string, node: unknown, type: FactType): Condition | string {
  const kind = type === "number" ? "a number" : "text";
  if (op === "in") {
    if (!isSeq(node) || node.items.length === 0 || node.items.length > MAX_RULE_LIST) return `in takes a list of 1 to ${MAX_RULE_LIST} values`;
    const values = node.items.map((one) => scalarOf(one, type));
    if (values.some((one) => one === null)) return `every value in the list is ${kind}`;
    return { fact, op, value: values as (string | number)[] };
  }
  if (op === "gte" || op === "lte") {
    const value = scalarOf(node, "number");
    return value === null ? `${op} takes a number` : { fact, op, value: value as number };
  }
  if (op === "eq") {
    const value = scalarOf(node, type);
    return value === null ? `eq takes ${kind}` : { fact, op, value };
  }
  const value = scalarOf(node, "string");
  return value === null ? `${op} takes text` : { fact, op: op as "has" | "match", value: value as string };
}

function factOf(facts: RuleFacts, name: string): string | number | readonly string[] | null {
  const visits = VISITS.exec(name);
  if (visits !== null) return facts.visits[visits[1]!] ?? 0;
  switch (name) {
    case "outcome":
      return facts.outcome;
    case "labels":
      return facts.labels;
    case "agent":
      return facts.agent;
    case "project":
      return facts.project;
    case "diff.files":
      return facts.diff?.files ?? null;
    case "diff.lines":
      return facts.diff?.lines ?? null;
    case "diff.paths":
      return facts.diff?.paths ?? null;
    default:
      return null;
  }
}

export function holds(condition: Condition, facts: RuleFacts): boolean {
  const value = factOf(facts, condition.fact);
  if (value === null) return false;
  switch (condition.op) {
    case "eq":
      return value === condition.value;
    case "in":
      return !Array.isArray(value) && condition.value.includes(value as string | number);
    case "gte":
      return typeof value === "number" && value >= condition.value;
    case "lte":
      return typeof value === "number" && value <= condition.value;
    case "has":
      return Array.isArray(value) && value.includes(condition.value);
    case "match": {
      const glob = globRegExp(condition.value);
      return Array.isArray(value) ? value.some((one) => glob.test(one)) : typeof value === "string" && glob.test(value);
    }
  }
}

/** The first rule whose every condition holds; a rule with no condition always does. */
export function firstMatch(rules: readonly Rule[], facts: RuleFacts): { index: number; then: string } | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.when.every((condition) => holds(condition, facts))) return { index, then: rule.then };
  }
  return null;
}

/** `*` and `?` stay inside one path segment, `**` crosses them. */
export function globRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
