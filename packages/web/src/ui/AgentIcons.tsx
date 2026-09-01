import type { ReactNode } from "react";
import { isBuiltinAgentId, type AgentId } from "../wire";

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
 * A harness a plugin added, drawn as a monogram.
 *
 * ⚠ **A letter rather than a fifth shape, and the choice is the opposite of the
 * one made four functions up.** Those four are shapes *of ours* standing for
 * programs whose marks we may not use; there is exactly one of each and they read
 * as a family. A machine can hold eight contributed harnesses, and one generic
 * mark for all of them would put eight identical tiles on a strip whose titles
 * `truncate` at 96px — the row would say nothing about which is which, which is
 * the failure the four distinct shapes exist to prevent.
 *
 * ⚠ **Derived from `agent` alone, so this takes no second prop.** A contributed id
 * is `<pluginId>:<localId>` and the letter comes off the local half — which is
 * also what keeps it stable when a plugin is renamed in a market. A prop carrying
 * the label would be the honest alternative and is not free: `webcheck` pins the
 * exact JSX of two `<AgentGlyph agent={…} size={…} />` call sites, and a
 * three-prop element there is a rewrite of two regexes for a letter this already
 * has.
 *
 * A letter in this app's own weight is not a mark and cannot be mistaken for one,
 * which is the property the four shapes are careful about.
 */
function MonogramGlyph({ agent, size }: { agent: string; size: number }): ReactNode {
  const local = agent.slice(agent.indexOf(":") + 1);
  // `Array.from` rather than `[0]`, so an id whose first character is outside the
  // BMP draws that character rather than half of it.
  const letter = (Array.from(local)[0] ?? "?").toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" strokeWidth={2} />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize="11"
        fontWeight="500"
        // The document's own stack, so the letter sits in the same family as the
        // title beside it rather than in whatever the SVG default resolves to.
        fontFamily="inherit"
      >
        {letter}
      </text>
    </svg>
  );
}

/**
 * The harness's glyph.
 *
 * ⚠ **Exhaustive over the four this product *ships*, with no `default` arm** —
 * which is the rule every per-harness table in this fleet keeps: a fifth built-in
 * is a compile error here rather than a tile that silently draws nothing.
 * `wire.ts`'s `AGENT_IDS` is a hand mirror and is the one seam with no compiler
 * help, so this is one of the places that makes adding to it loud.
 *
 * ⚠ **The narrowing is what preserves that, and removing it would be silent.**
 * `AgentId` is a string now, because a machine may offer harnesses a plugin added
 * — and a `switch` over a string has no exhaustiveness to check, so writing this
 * without `isBuiltinAgentId` would have deleted the only mechanism in the fleet
 * that makes a new harness loud, while the docblock above went on claiming it. The
 * `never` arm is reached only from inside the narrowing, where it means what it
 * says.
 */
export function AgentGlyph({ agent, size = 20 }: { agent: AgentId; size?: number }): ReactNode {
  if (!isBuiltinAgentId(agent)) return <MonogramGlyph agent={agent} size={size} />;
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
