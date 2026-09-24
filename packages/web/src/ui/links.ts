// Not `markdown.ts`: that would collide with `Markdown.tsx` on a case-insensitive filesystem.

/** Any other scheme would launch a program named by an agent-chosen string. */
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/**
 * Relative links, which react-markdown passes through, draw as text: an agent's path means nothing on this origin.
 * `null` rather than `""`, which would navigate to the current page.
 */
export function openableHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    // No base, so anything relative throws — which is the branch that matters.
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return OPENABLE.has(parsed.protocol) ? trimmed : null;
}
