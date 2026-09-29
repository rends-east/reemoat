import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/** Source with comments removed, so a rule quoted in prose cannot satisfy a regex. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SRC_ROOT = new URL("../src/", import.meta.url);

export function srcFile(rel: string): string {
  return readFileSync(new URL(rel, SRC_ROOT), "utf8");
}

export function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(new URL(dir, SRC_ROOT))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, SRC_ROOT)).isDirectory()) walk(`${path}/`, `${base}${entry}/`);
      else if (/\.tsx?$/.test(entry)) out.push(`${base}${entry}`);
    }
  };
  walk("", "");
  return out;
}

// Every module under `packages/web/src` an entry reaches, dynamic imports included: a lazy chunk is as much in the bundle as the entry.
export function closure(entry: string, valuesOnly = false): Set<string> {
  const root = new URL("../src/", import.meta.url);
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const parts = `${from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""}/${spec}`.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const base = stack.join("/");
    for (const candidate of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
      if (existsSync(new URL(candidate, root))) return candidate;
    }
    return null;
  };

  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(new URL(file, root), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const match of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      // `valuesOnly` skips type-only imports: TypeScript erases them, so they put no byte in a bundle.
      if (valuesOnly) {
        const upto = code.slice(0, match.index);
        const line = code.slice(upto.lastIndexOf("\n") + 1);
        if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
      }
      const next = resolve(file, match[1] ?? "");
      if (next !== null) queue.push(next);
    }
  }
  return seen;
}
