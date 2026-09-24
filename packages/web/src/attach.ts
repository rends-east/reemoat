import type { SessionKey } from "./ids";
import { MAX_PROMPT_ATTACHMENTS, MAX_UPLOAD_BYTES, type PromptAttachmentRef } from "./wire";

// Module state rather than useState (a phone unmounts the composer mid-upload) or the store (progress must not wake every subscriber).

export type AttachmentState = "uploading" | "ready" | "failed";

export interface PendingAttachment {
  /** Client-minted, and the React key. The daemon's id only exists once it is `ready`. */
  localId: string;
  // Held so a failed chip can be retried.
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

/** A no-op once the chip or its session is gone, so a completion after a switch or a removal needs no cancel. */
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

export function forgetAttachments(key: SessionKey): void {
  const list = pending.get(key);
  if (list === undefined) return;
  for (const item of list) item.cancel?.();
  pending.delete(key);
  changed();
}

/** Merges the restored chips ahead of any attached since, deduplicated by localId; overwriting would orphan in-flight uploads and their cancel. */
export function restoreAttachments(key: SessionKey, items: readonly PendingAttachment[]): void {
  if (items.length === 0) return;
  const live = pending.get(key) ?? NONE;
  pending.set(key, [
    ...items,
    ...live.filter((item) => !items.some((restored) => restored.localId === item.localId)),
  ]);
  changed();
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "text/plain": ".txt",
  "application/octet-stream": ".bin",
};

/** Names a nameless paste, which the daemon would refuse; at is passed in, and the stamp is UTC, so the result is assertable. */
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

/** Accepts a prefix when a batch overflows; an uploading chip holds a slot and a failed one does not. The per-session byte budget is the daemon's. */
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
      // A directory dropped onto a picker arrives as a zero-byte file.
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

/** Text or ready files, unless an upload is still in flight or the caller says the daemon would refuse (Composer's sendRefused). */
export function canSend(
  text: string,
  list: readonly PendingAttachment[],
  refused = false,
): boolean {
  if (refused) return false;
  const { ids, blocked } = sendableAttachments(list);
  if (blocked) return false;
  return text.trim().length > 0 || ids.length > 0;
}

/** Only chips the daemon has answered for, as in sendableAttachments; inlined is unknown until the prompt is accepted, so false. */
export function echoAttachments(list: readonly PendingAttachment[]): PromptAttachmentRef[] {
  const out: PromptAttachmentRef[] = [];
  for (const item of list) {
    if (item.state !== "ready" || item.uploadId === null) continue;
    out.push({
      uploadId: item.uploadId,
      name: item.name,
      mime: item.mimeType,
      bytes: item.size,
      inlined: false,
    });
  }
  return out;
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
