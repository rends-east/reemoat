import type { ReactNode } from "react";
import type { AgentId } from "../wire";

/*
 * A glyph per harness.
 *
 * ⚠ **Inline SVG, never an `<img>`** — `Mark.tsx`'s rule and its reasons apply
 * unchanged: the document's CSP is `img-src 'self' blob:`, so a `data:` URI is
 * refused outright, and a file would be a second request before the first paint
 * on a phone. (Plugin icons *are* `<img src>`, and that is the opposite trade for
 * the opposite reason: those bytes are somebody else's, and an SVG loaded as an
 * image runs no script.)
 *
 * ⚠ **Not vendor logos.** These are shapes of ours standing for four programs —
 * an asterisk, a chevron pair, a crescent, a bracket pair — drawn in one weight
 * so they read as one family at 20px on a strip. A real mark would be somebody's trademark
 * rendered in this app's monochrome palette at a size where it stops being
 * recognisable, which is worse than a shape that was never claiming to be one.
 *
 * `fill`/`stroke: currentColor`, so each takes the ink of whatever it sits in and
 * follows a picked tile into `font-medium text-fg` with no second token.
 */

/** Claude Code. An asterisk — the mark the CLI prints beside its own prompt. */
function ClaudeGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M12 4v16" />
        <path d="M5 8l14 8" />
        <path d="M19 8L5 16" />
      </g>
    </svg>
  );
}

/** Codex. A terminal chevron, which is what its own name is about. */
function CodexGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 7l5 5-5 5" />
        <path d="M13 17h5" />
      </g>
    </svg>
  );
}

/** Kimi CLI. A crescent. */
function KimiGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <path
        d="M19 15.5A8 8 0 0 1 8.5 5a8 8 0 1 0 10.5 10.5z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * opencode. A bracket pair — a delimiter, at the one weight the others use.
 *
 * Chosen against the three already here rather than for itself: the asterisk is
 * radial, the chevron points, the crescent is a closed curve, and two upright
 * brackets are none of those at 20px. Not `{}`, which reads as the chevron's
 * cousin at this size and is a shape half the strip could claim.
 */
function OpencodeGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <g stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 5H6v14h4" />
        <path d="M14 5h4v14h-4" />
      </g>
    </svg>
  );
}

/**
 * The harness's glyph.
 *
 * ⚠ **Exhaustive over `AgentId` with no `default` arm**, which is the rule every
 * per-agent table in this fleet keeps: a fourth harness is a compile error here
 * rather than a tile that silently draws nothing. `wire.ts`'s union is a hand
 * mirror and is the one seam with no compiler help, so this is one of the places
 * that makes adding to it loud.
 */
export function AgentGlyph({ agent, size = 20 }: { agent: AgentId; size?: number }): ReactNode {
  switch (agent) {
    case "claude":
      return <ClaudeGlyph size={size} />;
    case "codex":
      return <CodexGlyph size={size} />;
    case "kimi":
      return <KimiGlyph size={size} />;
    case "opencode":
      return <OpencodeGlyph size={size} />;
    default:
      return unglyphed(agent);
  }
}

/**
 * The arm that makes the exhaustiveness above real.
 *
 * ⚠ **The docblock claimed a missing arm was a compile error and it was not**,
 * for four releases: this function answers `ReactNode`, `undefined` inhabits
 * `ReactNode`, and a `switch` that falls off the end returns exactly that. So a
 * fourth harness would have drawn a blank tile and compiled clean — the failure
 * the comment was written to prevent, undetectable by the thing it named.
 *
 * `never` is what actually holds it. A fifth harness fails here, in this file,
 * naming the union it was added to.
 */
function unglyphed(agent: never): ReactNode {
  void agent;
  return null;
}
