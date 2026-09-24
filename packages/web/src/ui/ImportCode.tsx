import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, FileArchive, Loader2 } from "lucide-react";

import { store } from "../store";
import { ApiError, errorText } from "../http";
import { MAX_IMPORT_BYTES } from "../wire";
import { IMPORT_SKILL } from "../importSkill";
import { displayCwd } from "../paths";
import type { MachineId } from "../ids";
import { Button, Icon, SHEET_FOOT, SHEET_SCROLL } from "./bits";
import { Sheet } from "./Sheet";
import { copyText } from "./clipboard";
import { toast } from "./Toast";

/** A step inside the New session form on component state, not a route: a nested route would unmount the form and its choices (Q7.69). */

type Phase =
  | { kind: "idle" }
  | { kind: "sending"; name: string; fraction: number }
  /** All bytes sent and no answer yet; its own state, since a full bar reads as hung while the daemon unpacks. */
  | { kind: "unpacking"; name: string }
  | { kind: "failed"; message: string };

/** Keyed on the code, never the status; an old daemon's bare 404 is the feature detection. */
export function importFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === `http_${error.status}` && error.status === 404) {
      return "This machine's daemon is too old to import code. Update it and try again.";
    }
    const detail = error.detail as { name?: unknown } | null;
    switch (error.code) {
      case "import_exists":
        return `There is already a folder called ${typeof detail?.name === "string" ? detail.name : "that"} here.`;
      case "unsupported_archive":
        return "That is not a .zip or a .tar.gz.";
      case "archive_unsafe":
        return "That archive has something in it this daemon will not write — a link, or a path pointing outside itself.";
      case "archive_empty":
        return "There is nothing in that archive.";
      case "import_too_large":
        return `An archive has to be under ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`;
      case "import_unpacked_too_large":
      case "import_too_many_entries":
        return "That archive unpacks to more than this daemon will take. Leave out build output and dependencies.";
      case "import_busy":
        return "This machine is already unpacking an import. Try again in a moment.";
      case "tunnel_failed":
        return "The connection to this machine dropped while the archive was going up. Try again.";
      default:
        break;
    }
  }
  return errorText(error);
}

export function ImportCode({
  machineId,
  into,
  roots,
  onClose,
  onImported,
}: {
  machineId: MachineId;
  /** The folder the picker is standing in. The import lands inside it. */
  into: string;
  roots: readonly string[];
  onClose: () => void;
  /** The new folder's absolute path, for the picker to walk into. */
  onImported: (path: string) => void;
}): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  // Abort on unmount: an orphaned upload would hold the daemon's one-at-a-time import lock.
  useEffect(() => () => abort.current?.abort(), []);
  const busy = phase.kind === "sending" || phase.kind === "unpacking";

  const send = (file: File): void => {
    if (busy) return;
    if (file.size === 0) {
      // A dropped folder arrives as a zero-byte entry.
      setPhase({ kind: "failed", message: "That is empty. Drop the archive itself, not the folder." });
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setPhase({
        kind: "failed",
        message: `An archive has to be under ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
      });
      return;
    }

    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setPhase({ kind: "failed", message: "That machine is not reachable right now." });
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "sending", name: file.name, fraction: 0 });

    // Asked before the archive moves: an old daemon refuses mid-upload without draining the body, which surfaces as tunnel_failed.
    const run = async (): Promise<void> => {
      if (!(await daemon.importSupported())) {
        setPhase({
          kind: "failed",
          message: "This machine's daemon is too old to import code. Update it and try again.",
        });
        return;
      }
      const answer = await daemon.importArchive(
        into,
        file,
        file.name,
        (fraction) => {
          setPhase(
            fraction >= 1
              ? { kind: "unpacking", name: file.name }
              : { kind: "sending", name: file.name, fraction },
          );
        },
        controller.signal,
      );
      toast("ok", `Imported ${answer.import.name}`);
      onImported(answer.import.path);
      onClose();
    };

    void run()
      .catch((cause: unknown) => {
        if (controller.signal.aborted) {
          setPhase({ kind: "idle" });
          return;
        }
        setPhase({ kind: "failed", message: importFailure(cause) });
      })
      .finally(() => {
        abort.current = null;
      });
  };


  const copy = (): void => {
    void copyText(IMPORT_SKILL).then((ok) => {
      if (!ok) {
        toast("error", "Could not copy. Select the text and copy it by hand.");
        return;
      }
      setCopied(true);
    });
  };

  const pick = (files: FileList | null): void => {
    const file = files?.[0];
    if (file !== undefined) send(file);
  };

  return (
    <Sheet
      title="Import code"
      onClose={onClose}
      up={onClose}
      upLabel="New session"
      footer={
        <div className={SHEET_FOOT}>
          <p className="min-w-0 flex-1 truncate text-2xs text-muted" title={into}>
            Unpacks into <span className="font-mono">{displayCwd(into, roots)}</span>
          </p>
          {busy ? (
            <Button
              onClick={() => {
                abort.current?.abort();
              }}
            >
              Cancel
            </Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      }
    >
      <div
        className={SHEET_SCROLL}
        // onDragOver must preventDefault or drop never fires.
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Fires for every child the pointer crosses; only leaving the body counts.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          pick(event.dataTransfer.files);
        }}
      >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted">Bring in a project from wherever its code is now.</p>

        <Step n={1} text="Paste this into a coding agent open in that project.">
          {/* overscroll-contain: this box sits inside the sheet's own scroller. */}
          <div className="relative w-full">
            <pre className="max-h-56 overflow-y-auto overscroll-contain rounded-md border border-edge-strong bg-ink py-2.5 pr-16 pl-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-fg">
              {IMPORT_SKILL}
            </pre>
            <div className="absolute top-2 right-4">
              <button
                type="button"
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy to clipboard"}
                className="tap press relative flex min-h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface text-muted hover:bg-raised hover:text-fg"
              >
                <Icon
                  as={Copy}
                  size={13}
                  className={`absolute transition-opacity duration-300 ${copied ? "opacity-0" : "opacity-100"}`}
                />
                <Icon
                  as={Check}
                  size={13}
                  className={`absolute transition-opacity duration-300 ${copied ? "opacity-100" : "opacity-0"}`}
                />
              </button>
            </div>
          </div>
        </Step>

        <Step n={2} text="The agent packs the project into an archive and prints where it saved it." />

        <Step n={3} text="Drop it here, or press to choose.">
          <input
            ref={input}
            type="file"
            accept=".zip,.tgz,.tar.gz,application/zip,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(event) => {
              pick(event.target.files);
              // Cleared so choosing the same file twice still fires `change`.
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className={`tap press flex min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-3 text-center disabled:opacity-60 ${
              dragging ? "border-edge-strong bg-raised" : "border-edge-strong bg-surface hover:bg-raised"
            }`}
          >
            {phase.kind === "sending" || phase.kind === "unpacking" ? (
              <>
                <span className="flex items-center gap-2 text-sm text-fg">
                  <Icon as={Loader2} size={14} className="animate-spin" />
                  {phase.kind === "unpacking" ? "Unpacking…" : "Sending…"}
                </span>
                <span className="w-full max-w-64 truncate text-2xs text-muted">{phase.name}</span>
                <span className="h-1 w-full max-w-64 overflow-hidden rounded-full bg-raised">
                  <span
                    className="block h-full bg-edge-strong transition-[width]"
                    style={{
                      width: phase.kind === "unpacking" ? "100%" : `${Math.round(phase.fraction * 100)}%`,
                    }}
                  />
                </span>
              </>
            ) : (
              <>
                <Icon as={FileArchive} size={16} className="text-muted" />
                <span className="text-sm text-fg">Drop the archive here</span>
                <span className="text-2xs text-muted">.zip or .tar.gz</span>
              </>
            )}
          </button>
        </Step>

        {phase.kind === "failed" && <p className="text-sm text-danger wrap-anywhere">{phase.message}</p>}
      </div>
      </div>
    </Sheet>
  );
}

function Step({ n, text, children }: { n: number; text: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-2xs font-semibold text-muted">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <p className="text-sm text-fg">{text}</p>
        {children}
      </div>
    </div>
  );
}
