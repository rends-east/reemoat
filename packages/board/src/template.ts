// A run's prompt: text with {{name}} holes, from a fixed list of names, filled in as they are.

export const TEMPLATE_NAMES = ["task.title", "task.brief", "task.summary", "from.column", "from.exit", "from.report"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export type TemplateValues = Record<TemplateName, string>;

export type Template = { parts: (string | { name: TemplateName })[] };

/** What a run sends when it comes back to a column and its column names no prompt. */
export const RETURN_HINT = "The task came back from {{from.column}} ({{from.exit}}): {{from.report}}";
export const RETURN_BY_HAND_HINT = "The task came back from {{from.column}}: {{from.report}}";

const HOLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The template, or the refusal in words. */
export function parseTemplate(text: string): Template | string {
  const parts: Template["parts"] = [];
  let last = 0;
  for (const match of text.matchAll(HOLE)) {
    const name = match[1]!;
    if (!(TEMPLATE_NAMES as readonly string[]).includes(name)) {
      return `{{${name}}} is not a name a prompt knows; it knows ${TEMPLATE_NAMES.join(", ")}`;
    }
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ name: name as TemplateName });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  const literal = parts.filter((part): part is string => typeof part === "string").join("");
  if (literal.includes("{{")) return "a {{ is never closed; write {{ name }}";
  return { parts };
}

/** Values go in as they are: a prompt is the board owner's words with theirs filled in, never escaped. */
export function renderTemplate(template: Template, values: TemplateValues): string {
  return template.parts.map((part) => (typeof part === "string" ? part : values[part.name])).join("");
}

export const RETURN_TEMPLATE = parseTemplate(RETURN_HINT) as Template;
export const RETURN_BY_HAND_TEMPLATE = parseTemplate(RETURN_BY_HAND_HINT) as Template;
