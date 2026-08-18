import type { SessionKey } from "./ids";
import { MAX_PROMPT_ATTACHMENTS, MAX_UPLOAD_BYTES } from "./wire";

/**
 * Files a person has attached to a message they have not sent yet.
 *
 * **Module state with its own subscribers, not `useState` and not the store**,
 * and both halves of that are decisions this codebase has already made once.
 * Not `useState`, because on a phone list → detail → back unmounts the composer:
 * somebody who attaches a photo, checks another session and comes back would find
 * the chip gone while the bytes are already on the daemon — an orphan nobody can
 * reference. That is exactly why drafts live outside React. And not the store,
 * because `Composer` says in as many words that a keystroke must not wake every
 * subscriber including the session list, and an upload reporting progress is
 * strictly worse than a keystroke.
 *
 * It sits at `src/` rather than `src/ui/` because `store.ts` imports it —
 * `forgetSession` is where per-session state dies, and an in-flight upload is
 * per-session state — and `store.ts` → `ui/` would be a new and wrong edge.
 */

export type AttachmentState = "uploading" | "ready" | "failed";

export interface PendingAttachment {
  /** Client-minted, and the React key. The daemon's id only exists once it is `ready`. */
  localId: string;
  /**
   * The file itself, held so a failed chip can be retried.
   *
   * A `File` is a handle to something already on disk rather than a copy in the
   * heap, so keeping it costs nothing until it is read.
   */
  file: File;
  name: string;
  size: number;
  mimeType: string;
  state: AttachmentState;
  /** 0..1, and 0 when the browser cannot say. */
  progress: number;
  /** Set only in `ready`. */
  uploadId: string | null;
  /** The daemon's own message, in `failed`. */
  error: string | null;
  /** Aborts the upload in flight. */
  cancel: (() => void) | null;
}

const pending = new Map<SessionKey, PendingAttachment[]>();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` compares by identity, so the snapshot has to be stable. */
let version = 0;

const NONE: readonly PendingAttachment[] = [];

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function attachmentsFor(key: SessionKey): readonly PendingAttachment[] {
  return pending.get(key) ?? NONE;
}

export function subscribeAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function attachmentsVersion(): number {
  return version;
}

export function addAttachments(key: SessionKey, items: readonly PendingAttachment[]): void {
  if (items.length === 0) return;
  pending.set(key, [...(pending.get(key) ?? []), ...items]);
  changed();
}

/**
 * Update one chip, if it is still there.
 *
 * The no-op when it is gone is the whole reason a session switch mid-upload does
 * not have to cancel anything: the completion callback resolves `(key, localId)`
 * and simply does nothing if the person removed the chip or the session went
 * away. Same property drafts already have, for the same reason.
 */
export function updateAttachment(key: SessionKey, localId: string, patch: Partial<PendingAttachment>): void {
  const list = pending.get(key);
  if (list === undefined) return;
  const index = list.findIndex((item) => item.localId === localId);
  if (index === -1) return;
  const next = [...list];
  next[index] = { ...next[index]!, ...patch };
  pending.set(key, next);
  changed();
}

export function removeAttachment(key: SessionKey, localId: string): void {
  const list = pending.get(key);
  if (list === undefined) return;
  const target = list.find((item) => item.localId === localId);
  target?.cancel?.();
  const next = list.filter((item) => item.localId !== localId);
  if (next.length === 0) pending.delete(key);
  else pending.set(key, next);
  changed();
}

/** Everything for one session, aborting anything still in flight. */
export function forgetAttachments(key: SessionKey): void {
  const list = pending.get(key);
  if (list === undefined) return;
  for (const item of list) item.cancel?.();
  pending.delete(key);
  changed();
}

/**
 * Restore a list the composer cleared optimistically, when the send was refused.
 *
 * **Merged into whatever is there now, never assigned over it.** Nothing stops a
 * file being attached while a prompt is in flight — `onPaste`, `onDrop` and the
 * paperclip all stay live, and the prompt is on a 90s budget — and an assignment
 * deleted those entries on the way back. That is worse than losing a chip: the
 * upload behind it keeps streaming to completion, spending one of the daemon's
 * per-session 100 files and 100 MiB, and its `cancel` closure went with the entry,
 * so `removeAttachment` and `forgetAttachments` have nothing left to abort with.
 * The person then retries the send and it goes without the screenshot they
 * attached — the same failure `Composer`'s `send` reads the list live to prevent,
 * arriving from the other side.
 *
 * Restored first, because they were attached first and that is the order the
 * refused message had them in. Deduplicated by `localId`, since a restore that
 * raced a partial restore would otherwise draw one file twice.
 */
export function restoreAttachments(key: SessionKey, items: readonly PendingAttachment[]): void {
  if (items.length === 0) return;
  const live = pending.get(key) ?? NONE;
  pending.set(key, [
    ...items,
    ...live.filter((item) => !items.some((restored) => restored.localId === item.localId)),
  ]);
  changed();
}

/**
 * Extensions worth spelling rather than deriving.
 *
 * Everything else takes its subtype verbatim, which is right far more often than
 * a table would be — `application/pdf` is `.pdf`, `text/csv` is `.csv`.
 */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "application/octet-stream": ".bin",
};

/**
 * What to call a file that arrived without a name.
 *
 * **A pasted screenshot is the case this exists for, and it is the common one
 * rather than the edge.** Most browsers hand back a `File` called `image.png`,
 * but not all of them and not for every source — and an empty name is refused by
 * the daemon's `sanitizeUploadName` with `400 invalid_name`, which would have
 * made Ctrl+V fail with an opaque error in exactly the situation somebody reaches
 * for it. So the client names it rather than finding out.
 *
 * `at` is a parameter rather than a `Date.now()` call so the rule stays pure and
 * `webcheck` can assert the shape it produces. UTC, for the same reason: a
 * timestamp that changes with the reader's timezone is not assertable.
 */
export function pastedName(name: string, mime: string, at: number): string {
  const given = name.trim();
  if (given.length > 0) return given;

  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const subtype = type.includes("/") ? (type.split("/")[1] ?? "") : "";
  const extension =
    EXTENSIONS[type] ?? (/^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".bin");

  const stamp = new Date(at).toISOString().slice(0, 19).replace(/[:-]/g, "").replace("T", "-");
  return `pasted-${stamp}${extension}`;
}

export type FileRefusal = "too_many" | "too_large" | "empty";

export interface Admission {
  accepted: File[];
  refused: { file: File; reason: FileRefusal }[];
}

/**
 * Which of these files the composer will take.
 *
 * A **prefix** is accepted when a batch straddles the count limit rather than the
 * whole batch being refused: a picker handing back twelve files when there is
 * room for three should attach three and say so, not refuse all twelve and make
 * somebody pick again.
 *
 * An `uploading` chip occupies a slot and a `failed` one does not. That is the
 * rule to know, and it is the one that would otherwise be decided differently in
 * two places: a failed chip is not going to be sent, so counting it would refuse
 * a file for a slot nothing is using — while an uploading one is on its way to
 * being sent and its bytes are already on the daemon.
 *
 * Only the two client-side limits live here. The 100 MiB per-session budget is
 * the daemon's and stays there: this client cannot know it across a reload, and a
 * half-tracked counter that is wrong after F5 is worse than a chip carrying the
 * daemon's own refusal.
 */
export function admitFiles(existing: readonly PendingAttachment[], incoming: readonly File[]): Admission {
  let slots = MAX_PROMPT_ATTACHMENTS - existing.filter((item) => item.state !== "failed").length;
  const accepted: File[] = [];
  const refused: { file: File; reason: FileRefusal }[] = [];

  for (const file of incoming) {
    if (file.size > MAX_UPLOAD_BYTES) {
      refused.push({ file, reason: "too_large" });
      continue;
    }
    if (file.size === 0) {
      // Not a limit, a mistake: a directory dropped onto a picker arrives as a
      // zero-byte entry, and the daemon would store it as a real empty file.
      refused.push({ file, reason: "empty" });
      continue;
    }
    if (slots <= 0) {
      refused.push({ file, reason: "too_many" });
      continue;
    }
    slots -= 1;
    accepted.push(file);
  }
  return { accepted, refused };
}

/**
 * What goes on the wire, and whether sending should wait.
 *
 * `blocked` is a visible refusal rather than a silent drop: an upload still in
 * flight has no `uploadId` yet, so sending now would send the message without the
 * file somebody attached to it. A `failed` chip does **not** block — it is not
 * going to be sent and it is not going to finish, so holding Send hostage to it
 * would leave no way out but removing it.
 *
 * The `ready`-without-an-id case cannot happen, and is refused rather than
 * trusted: an impossible state that reaches the wire sends an empty attachment
 * list under a message that says it has files.
 */
/**
 * May this message be sent at all?
 *
 * Text **or** files, and that is the point: a message that is only a screenshot
 * is an ordinary thing to send, and the composer used to refuse it because the
 * only guard was on the text. The daemon allows it too — the two have to agree,
 * or Send is enabled onto a `400`.
 *
 * An upload in flight wins over everything. It has no id yet, so sending would
 * deliver the message without the file it is about — which for a files-only
 * message means delivering nothing at all.
 *
 * **`busy` is the turn, and it is here because the composer was lying about it.**
 * `ManagedSession.prompt` refuses outright while `this.turn !== null` — there is
 * no queue anywhere in this system — so every message typed while the agent was
 * working, or while a question was parked, came back `409 turn_in_flight` and
 * surfaced as a red toast. Send was enabled onto a route that could only fail.
 * Two things said otherwise and both were wrong: the button's own tooltip read
 * "Send — queues behind the current turn", and CLAUDE.md said the message sends
 * with no error and the reply arrives after the current one.
 *
 * So the rule the daemon actually has is the rule the button now has, and the
 * placeholder already explains both halves of it — `composerPlaceholder` says
 * "answer the request above first" while something is parked and "agent is
 * working…" otherwise. A disabled control next to a sentence saying why beats a
 * live control that throws.
 *
 * Type-ahead is what this costs, and it is worth naming rather than pretending it
 * was never there: you can still write the message, it just will not go until the
 * turn ends. A real queue — hold it and send it on the next idle — is a feature
 * with its own failure modes (a session that ends, a tab that closes) and is not
 * something to arrive at by way of a button that used to error.
 */
export function canSend(
  text: string,
  list: readonly PendingAttachment[],
  busy = false,
): boolean {
  if (busy) return false;
  const { ids, blocked } = sendableAttachments(list);
  if (blocked) return false;
  return text.trim().length > 0 || ids.length > 0;
}

export function sendableAttachments(list: readonly PendingAttachment[]): { ids: string[]; blocked: boolean } {
  const ids: string[] = [];
  let blocked = false;
  for (const item of list) {
    if (item.state === "uploading") blocked = true;
    if (item.state !== "ready") continue;
    if (item.uploadId === null) continue;
    ids.push(item.uploadId);
  }
  return { ids, blocked };
}
