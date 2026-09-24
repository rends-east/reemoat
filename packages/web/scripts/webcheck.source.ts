import { readFileSync, readdirSync, statSync } from "node:fs";

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
