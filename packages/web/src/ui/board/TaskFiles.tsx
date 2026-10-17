import { Download, Paperclip, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { pastedName } from "../../attach";
import { ApiError, errorText, meansRouteAbsent } from "../../http";
import type { MachineId } from "../../ids";
import { formatBytes } from "../../paths";
import { previewable } from "../../preview";
import { store } from "../../store";
import { MAX_PROMPT_ATTACHMENTS, MAX_UPLOAD_BYTES, type TaskFile } from "../../wire";
import { Button, Icon, IconButton } from "../bits";
import { saveBlob } from "../download";
import { ImagePreview } from "../ImagePreview";
import { toast } from "../Toast";

/** A file picked for a task or a comment, held here until the press that sends it, and only then uploaded to the task's machine (Q3.744). */
export interface PickedFile {
  localId: string;
  file: File;
  name: string;
  /** 0..1 while it uploads, null before. */
  progress: number | null;
}

let pickSeq = 0;

/** What a picker, a drop or a paste adds past the files already picked; a file that cannot go is said and left out. */
export function pickFiles(held: readonly PickedFile[], incoming: readonly File[]): PickedFile[] {
  const at = Date.now();
  const added: PickedFile[] = [];
  for (const file of incoming) {
    if (file.size > MAX_UPLOAD_BYTES) toast("error", `${file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`);
    // A folder dropped onto a picker arrives as a file of no bytes.
    else if (file.size === 0) toast("error", `${file.name || "that file"} is empty`);
    else if (held.length + added.length >= MAX_PROMPT_ATTACHMENTS) {
      toast("error", `at most ${MAX_PROMPT_ATTACHMENTS} files at once`);
      break;
    } else added.push({ localId: `p_${pickSeq++}`, file, name: pastedName(file.name, file.type, at), progress: null });
  }
  return [...held, ...added];
}

/** Uploads each picked file to the task's machine, one after another, and answers the ids a create or a comment names. */
export async function uploadPicked(
  machineId: MachineId,
  picked: readonly PickedFile[],
  onProgress: (localId: string, fraction: number) => void,
): Promise<string[]> {
  if (picked.length === 0) return [];
  const daemon = store.daemonFor(machineId);
  if (daemon === undefined) throw new Error("That machine is not connected right now.");
  const ids: string[] = [];
  for (const one of picked) {
    try {
      const answer = await daemon.uploadTaskFile(one.file, one.name, (fraction) => onProgress(one.localId, fraction), new AbortController().signal);
      ids.push(answer.upload.uploadId);
    } catch (cause: unknown) {
      if (meansRouteAbsent(cause)) throw new Error("That machine is too old to keep files on a task. Update it, then send them again.");
      throw new Error(`${one.name}: ${errorText(cause)}`);
    }
  }
  return ids;
}

/** The paperclip and its hidden picker, alone or with `text` beside it; `onPick` gets what was chosen. */
export function AttachButton({ onPick, disabled, text }: { onPick: (files: File[]) => void; disabled: boolean; text?: string }): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {text === undefined ? (
        <IconButton icon={Paperclip} label="Attach files" title="Attach files" size="chip" disabled={disabled} onClick={() => input.current?.click()} />
      ) : (
        <Button size="sm" tone="ghost" disabled={disabled} onClick={() => input.current?.click()} className="self-start">
          <Icon as={Paperclip} size={13} />
          {text}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          onPick([...(event.currentTarget.files ?? [])]);
          // Cleared, or picking the same file again fires no change.
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

/** The files picked and not sent yet, as the composer draws its own; while they upload each says how far it got. */
export function PickedFiles({ files, onRemove, busy }: { files: readonly PickedFile[]; onRemove: (localId: string) => void; busy: boolean }): ReactNode {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-1.5 gap-y-3">
      {files.map((item) => (
        <li key={item.localId} className="flex max-w-full items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-2xs">
          <Icon as={Paperclip} size={11} className="shrink-0 text-faint" />
          <span className="min-w-0 truncate font-mono">{item.name}</span>
          <span className="shrink-0 text-faint">
            {item.progress === null ? formatBytes(item.file.size) : `${Math.round(item.progress * 100)}%`}
          </span>
          <IconButton icon={X} label={`Remove ${item.name}`} size="sm" disabled={busy} onClick={() => onRemove(item.localId)} />
        </li>
      ))}
    </ul>
  );
}

/** Picked files as one piece of state, for a form that sends them on its own press. */
export function usePickedFiles(initial: readonly PickedFile[] = [], onChange?: (files: readonly PickedFile[]) => void): {
  files: readonly PickedFile[];
  add: (incoming: readonly File[]) => void;
  remove: (localId: string) => void;
  progress: (localId: string, fraction: number) => void;
  clear: () => void;
} {
  const [files, setFiles] = useState<readonly PickedFile[]>(initial);
  const write = (next: (before: readonly PickedFile[]) => readonly PickedFile[]): void =>
    setFiles((before) => {
      const after = next(before);
      onChange?.(after);
      return after;
    });
  return {
    files,
    add: (incoming) => {
      if (incoming.length > 0) write((before) => pickFiles(before, incoming));
    },
    remove: (localId) => write((before) => before.filter((one) => one.localId !== localId)),
    progress: (localId, fraction) => write((before) => before.map((one) => (one.localId === localId ? { ...one, progress: fraction } : one))),
    clear: () => write(() => []),
  };
}

/** A task's or a comment's files, kept on its machine: an image is shown, and every one downloads. */
export function TaskFileList({ machineId, taskId, files }: { machineId: MachineId; taskId: string; files: readonly TaskFile[] }): ReactNode {
  if (files.length === 0) return null;
  const fetch = (file: TaskFile): Promise<Blob> => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return Promise.reject(new Error("That machine is not connected right now."));
    return daemon.downloadTaskFile(taskId, file.id);
  };
  const download = async (file: TaskFile): Promise<void> => {
    try {
      await saveBlob(await fetch(file), file.name);
    } catch (cause: unknown) {
      // A task that went to another machine left its files here: that machine has none of them (Q2.273).
      const gone = ApiError.isApiError(cause) && cause.code === "upload_not_found";
      toast("error", gone ? `${file.name} is not kept on this task's machine.` : errorText(cause));
    }
  };
  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((file) => (
        <li key={file.id} className="flex flex-col gap-1">
          {previewable(file.mime, file.bytes) && <ImagePreview cacheKey={`t:${machineId}:${taskId}:${file.id}`} fetcher={() => fetch(file)} alt={file.name} />}
          <div className="flex items-center gap-1.5 rounded-md border border-edge/60 px-2 py-1 text-2xs">
            <Icon as={Paperclip} size={11} className="shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
            <span className="shrink-0 text-faint">{formatBytes(file.bytes)}</span>
            <button
              type="button"
              aria-label={`Download ${file.name}`}
              title={`Download ${file.name}`}
              onClick={() => void download(file)}
              className="tap shrink-0 rounded p-0.5 text-faint hover:text-fg"
            >
              <Icon as={Download} size={11} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
