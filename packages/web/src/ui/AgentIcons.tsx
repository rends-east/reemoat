import type { ReactNode } from "react";
import { isBuiltinAgentId, type AgentId } from "../wire";

// Inline SVG, never an img (the CSP refuses data URIs); shapes of ours rather than vendor logos, inked with currentColor.

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

function GrokGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <path
        d="M12 3 21 12 12 21 3 12Z"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A plugin harness drawn as the first letter of its local id, so several contributed harnesses stay distinguishable. */
function MonogramGlyph({ agent, size }: { agent: string; size: number }): ReactNode {
  const local = agent.slice(agent.indexOf(":") + 1);
  // Array.from so a first character outside the BMP is drawn whole.
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
        fontFamily="inherit"
      >
        {letter}
      </text>
    </svg>
  );
}

/** Exhaustive over the five shipped harnesses inside the isBuiltinAgentId narrowing, so a new built-in is a compile error. */
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
    case "grok":
      return <GrokGlyph size={size} />;
    default:
      return unglyphed(agent);
  }
}

// The never parameter is what makes a missing arm a compile error.
function unglyphed(agent: never): ReactNode {
  void agent;
  return null;
}
