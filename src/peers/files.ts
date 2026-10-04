import { isAbsolute, resolve } from "node:path";
import type { StoredFileRef } from "../events.js";
import { expandHome } from "../paths.js";
import { MAX_SENT_FILE_BYTES, type KeepFileResult } from "../uploads.js";

export const SEND_FILE_TOOL_NAME = "send_file";

/** `file` is what the transcript now shows, `path` where it was read; a refusal is a sentence for the model, never an HTTP error. */
export type SendFileResult = { ok: true; file: StoredFileRef; path: string } | { ok: false; message: string };

/** No shorter than the longest path the platforms this runs on will open. */
export const MAX_SEND_FILE_PATH_BYTES = 4096;

export const SEND_FILE_INSTRUCTIONS =
  "send_file puts a file from this machine in front of your user in the chat, as a card they can open or download; an image is shown inline. " +
  "Your user may be on a phone or another computer and cannot open a path you print, so use it whenever they ask for a file " +
  "and whenever what you made for them is a file.";

export const SEND_FILE_TOOL = {
  name: SEND_FILE_TOOL_NAME,
  description:
    "Send a file from this machine to your user in the chat. They see a card with its name and size and can download it; " +
    "an image is shown inline. Use it when your user asks for a file, and when what you produced for them is a file they " +
    "will want to open: a report, an export, an archive, a build, a screenshot. Your user may be on another device, where a " +
    "path you print opens nothing. The file is copied as it is now, so send it again after changing it. One file per call, " +
    `up to ${megabytes(MAX_SENT_FILE_BYTES)} MB. Not for source you edited in the working folder: your user already sees those changes.`,
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "The file to send: an absolute path is best. One starting with ~ is from your home folder, and any other is taken " +
          "from the session's working folder, not from wherever your shell has moved to.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

/** ASCII only: a no-break or ideographic space at an end can be part of a real name, where a stray newline from the model is not. */
const EDGE_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

/** The path as the daemon will read it, or the refusal, worded for the model. */
export function sendFileSource(args: Record<string, unknown>, cwd: string): { path: string } | string {
  const path = args["path"];
  const trimmed = typeof path === "string" ? path.replace(EDGE_WHITESPACE, "") : "";
  if (trimmed.length === 0) return "path must be the file to send";
  if (trimmed.includes("\0")) return "path may not hold a NUL byte";
  if (Buffer.byteLength(trimmed, "utf8") > MAX_SEND_FILE_PATH_BYTES) return `path may be at most ${MAX_SEND_FILE_PATH_BYTES} bytes`;
  const expanded = expandHome(trimmed);
  return { path: isAbsolute(expanded) ? expanded : resolve(cwd, expanded) };
}

/** `path` is the one read, so a relative path taken from the wrong folder shows where it went. */
export function sendFileRefusal(result: Exclude<KeepFileResult, { kind: "ok" }>, path: string): string {
  switch (result.kind) {
    case "missing":
      return `there is no file at ${path}`;
    case "denied":
      return `this machine would not let the daemon read ${path}; nothing was sent`;
    case "not_a_file":
      return `${path} is not a regular file; to send a folder, archive it and send the archive`;
    case "process_file":
      return `${path} is a view of a running process, not a file; nothing was sent`;
    case "unresponsive":
      return `the filesystem under ${path} is not answering; nothing was sent`;
    case "too_large":
      return `${path} is larger than the ${megabytes(result.limit)} MB a sent file may be; nothing was sent`;
    case "rate":
      return `too much has been sent from this session in the last few minutes; try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds`;
    case "cancelled":
      return "the call was cancelled before the file was copied; nothing was sent";
    case "withdrawn":
      return "the session stopped before the file was kept; nothing was sent";
    case "timed_out":
      return `copying ${path} took too long; nothing was sent`;
    case "failed":
      return `could not send ${path}: ${result.detail}`;
  }
}

export function sentFileText(file: StoredFileRef, path: string): string {
  return (
    `Sent ${path} to your user as ${file.name} (${sizeText(file.bytes)}): it is in the chat now. ` +
    "Do not print its contents or its path again."
  );
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
