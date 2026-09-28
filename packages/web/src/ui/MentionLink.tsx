import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { machineId, refOf, sessionId } from "../ids";
import { mentionTarget, splitMentions, type MentionTarget } from "../mentionLinks";
import { store } from "../store";
import type { PromptMention } from "../wire";

/** The machine the drawn text belongs to, and the names its daemon resolved; null outside a conversation. */
export interface MentionScopeValue {
  here: string | null;
  mentions: readonly PromptMention[];
}

export const MentionScope = createContext<MentionScopeValue>({ here: null, mentions: [] });

/**
 * `@name`, a link to that session where this client can open one and the same text where it cannot. Q3.682.
 * The store is read through a string key, so a streamed event re-renders no link whose target did not move.
 */
export function MentionLink({ name, exact = null }: { name: string; exact?: MentionTarget | null }): ReactNode {
  const scope = useContext(MentionScope);
  const key = useSyncExternalStore(store.subscribe, () => {
    const target = mentionTarget(name, { ...scope, exact }, store.getSnapshot().sessions);
    return target === null ? "" : `${target.machineId}/${target.sessionId}`;
  });
  if (key === "") return <>@{name}</>;
  const slash = key.indexOf("/");
  const ref = refOf(machineId(key.slice(0, slash)), sessionId(key.slice(slash + 1)));
  return (
    // A button, not an anchor: it moves within the app, and `select-text` keeps the name in a copied message. Under the
    // pointer, the whole `@name` sits in a pill and the pointer changes: the third named exception to Q3.627, on the owner's word.
    <button
      type="button"
      onClick={() => void openSession(ref)}
      className="-mx-1 inline cursor-pointer rounded-full px-1 py-0.5 font-medium text-fg select-text transition-colors hover:bg-edge"
    >
      @{name}
    </button>
  );
}

// Loaded on the tap: the router reads the address bar as it loads, and the transcript is imported where there is none.
async function openSession(ref: ReturnType<typeof refOf>): Promise<void> {
  const { navigate, sessionPath } = await import("../router");
  navigate(sessionPath(ref));
}

/** A person's words with each `@name` a link, the rest as typed; `mentions` is what the daemon resolved for them. */
export function MentionText({ text, mentions }: { text: string; mentions?: readonly PromptMention[] }): ReactNode {
  const outer = useContext(MentionScope);
  const scope = useMemo(() => ({ here: outer.here, mentions: mentions ?? [] }), [outer.here, mentions]);
  const parts = useMemo(() => splitMentions(text), [text]);
  if (!parts.some((part) => part.kind === "mention")) return <>{text}</>;
  return (
    <MentionScope.Provider value={scope}>
      {parts.map((part, index) => (part.kind === "text" ? part.text : <MentionLink key={index} name={part.name} />))}
    </MentionScope.Provider>
  );
}
