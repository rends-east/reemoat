/** A task's feed as its page draws it: which request a question is a window on, whether it still waits, and the order. No DOM: webcheck imports it. */

import type { PendingElicitationSnapshot, PendingPermissionSnapshot, TaskCommentView, TaskEventView, TaskPhase } from "./wire";

/** What a question entry draws: the session's own card while the session holds the request, else the entry closed. */
export type QuestionShown =
  | { kind: "permission"; pending: PendingPermissionSnapshot }
  | { kind: "elicitation"; pending: PendingElicitationSnapshot }
  | { kind: "closed" };

/** The requests a session row holds, as the store last heard them; absent where the row is not held. */
export interface HeldRequests {
  pendingPermissions: readonly PendingPermissionSnapshot[];
  pendingElicitations?: readonly PendingElicitationSnapshot[];
}

function isPermission(value: unknown): value is PendingPermissionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const one = value as Record<string, unknown>;
  return typeof one["permissionId"] === "string" && typeof one["title"] === "string" && Array.isArray(one["options"]);
}

function isElicitation(value: unknown): value is PendingElicitationSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const one = value as Record<string, unknown>;
  return typeof one["elicitationId"] === "string" && typeof one["message"] === "string";
}

/**
 * A question is a window on a request its session holds, never a copy: the session row this client holds is the fresher word,
 * and decides; only where no row is held does the feed's own reading stand. An answer from the chat closes it here by itself.
 */
export function questionShown(comment: Pick<TaskCommentView, "kind" | "request" | "state" | "pending">, row: HeldRequests | undefined): QuestionShown {
  const request = comment.request;
  if (comment.kind !== "question" || request === null) return { kind: "closed" };
  if (row !== undefined) {
    if (request.kind === "permission") {
      const pending = row.pendingPermissions.find((one) => one.permissionId === request.id);
      return pending === undefined ? { kind: "closed" } : { kind: "permission", pending };
    }
    const pending = (row.pendingElicitations ?? []).find((one) => one.elicitationId === request.id);
    return pending === undefined ? { kind: "closed" } : { kind: "elicitation", pending };
  }
  if (comment.state !== "open") return { kind: "closed" };
  if (request.kind === "permission" && isPermission(comment.pending) && comment.pending.permissionId === request.id) {
    return { kind: "permission", pending: comment.pending };
  }
  if (request.kind === "elicitation" && isElicitation(comment.pending) && comment.pending.elicitationId === request.id) {
    return { kind: "elicitation", pending: comment.pending };
  }
  return { kind: "closed" };
}

/** The feed reads as a conversation, oldest first, with the box under it; a tie keeps the daemon's order. */
export function feedOrder(comments: readonly TaskCommentView[]): TaskCommentView[] {
  return comments.map((comment, index) => ({ comment, index })).sort((a, b) => a.comment.at - b.comment.at || a.index - b.index).map((one) => one.comment);
}

/** The history reads newest first, as the page's activity always did: what happened last is what is looked for. */
export function historyOrder(events: readonly TaskEventView[]): TaskEventView[] {
  return [...events].sort((a, b) => b.at - a.at || b.seq - a.seq);
}

/**
 * The stop a reply would answer: the newest one, while the task still needs its person and nobody has written since. A reply is
 * an ordinary comment, which the daemon puts into the run's own conversation.
 */
export function openStop(comments: readonly TaskCommentView[], phase: TaskPhase): TaskCommentView | null {
  if (phase !== "needs_you") return null;
  const ordered = feedOrder(comments);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const comment = ordered[index]!;
    if (comment.kind === "stop") return comment;
    if (comment.author === "you") return null;
  }
  return null;
}

/** Who wrote an entry, as the page names them: its person, a conversation of the task by its nickname, else one it no longer holds. */
export function authorName(author: string, sessions: readonly { id: string; nickname: string }[]): string {
  if (author === "you") return "You";
  const session = sessions.find((one) => one.id === author);
  return session === undefined ? "An earlier conversation" : `@${session.nickname}`;
}

/** Where a person's comment went: into the conversation at work, or the next run's note. */
export function deliveredText(comment: Pick<TaskCommentView, "author" | "delivered" | "kind">): string | null {
  if (comment.author !== "you" || comment.kind !== "comment") return null;
  return comment.delivered ? "sent to the agent" : "for the next run";
}
