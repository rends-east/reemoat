/** Source with comments removed, so a rule quoted in prose cannot satisfy a regex. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
