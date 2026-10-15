import { UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskHolder } from "../../board";
import { AgentMark } from "../AgentIcons";
import { agentLabel } from "../agentCard";
import { Icon } from "../bits";

// No router here: the proposals card draws this mark too.

export function holderLabel(holder: TaskHolder): string {
  return holder.kind === "nobody" ? "Not assigned" : holder.kind === "you" ? "You" : agentLabel(holder.agent);
}

/** Who holds a task, as a tracker draws an assignee: one round mark, dashed while nobody does (Q3.727). */
export function HolderAvatar({ holder, me, size = "sm" }: { holder: TaskHolder; me: string | null; size?: "sm" | "md" }): ReactNode {
  const box = size === "md" ? "h-6 w-6" : "h-5 w-5";
  const label = holderLabel(holder);
  if (holder.kind === "nobody") {
    return (
      <span title={label} className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full border border-dashed border-edge-strong text-faint`}>
        <Icon as={UserRound} size={size === "md" ? 13 : 11} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  if (holder.kind === "you") {
    const letter = [...(me ?? "").trim()][0]?.toUpperCase() ?? "";
    return (
      <span title={label} className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full bg-fg text-2xs font-semibold text-surface`}>
        {letter.length > 0 ? <span aria-hidden="true">{letter}</span> : <Icon as={UserRound} size={size === "md" ? 13 : 11} />}
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className={`inline-flex ${box} shrink-0 items-center justify-center rounded-full border border-edge bg-surface text-fg`}>
      <AgentMark agent={holder.agent} size={size === "md" ? 13 : 11} />
    </span>
  );
}
