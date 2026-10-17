// A task's files: staged by an upload, moved to the task by the create or comment that names them, and copied into each
// run's session as that session's own, so its transcript can still hand them back (Q2.273).
import type { ReceiveRequest, ReceiveResult, Uploads, UploadRow } from "../uploads.js";
import { MAX_TASK_FILE_BYTES, MAX_TASK_FILES, type TaskFile } from "./store.js";

/** Where an upload waits until a create or a comment names it; one nothing names goes after a day, as a session's does. */
export const STAGED = "staged";

export type ClaimResult =
  | { ok: true; files: TaskFile[] }
  | { ok: false; code: "unknown_attachment"; uploadId: string }
  | { ok: false; code: "task_files_full" }
  | { ok: false; code: "upload_write_failed"; detail: string };

function fileOf(row: UploadRow): TaskFile {
  return { id: row.uploadId, name: row.name, mime: row.mime, bytes: row.bytes };
}

export class TaskFiles {
  /** `sessions` is where a run's conversation keeps its files; absent, a task's files reach no agent. */
  constructor(
    private readonly store: Uploads,
    private readonly sessions: Uploads | null,
  ) {}

  stage(request: ReceiveRequest): Promise<ReceiveResult> {
    return this.store.receive(STAGED, request);
  }

  /** The first id nothing is staged under, or null: asked before a create makes the task its files would go to. */
  missing(ids: readonly string[]): string | null {
    const found = this.store.resolve(STAGED, ids);
    return found.ok ? null : found.missing;
  }

  async claim(taskId: string, ids: readonly string[]): Promise<ClaimResult> {
    if (ids.length === 0) return { ok: true, files: [] };
    const found = this.store.resolve(STAGED, ids);
    if (!found.ok) return { ok: false, code: "unknown_attachment", uploadId: found.missing };
    const kept = [...this.store.rowsOf(taskId), ...found.rows];
    if (kept.length > MAX_TASK_FILES || kept.reduce((sum, row) => sum + row.bytes, 0) > MAX_TASK_FILE_BYTES) return { ok: false, code: "task_files_full" };
    const moved = await this.store.claim(STAGED, ids, taskId);
    if (moved.ok) return { ok: true, files: moved.rows.map(fileOf) };
    return "missing" in moved ? { ok: false, code: "unknown_attachment", uploadId: moved.missing } : { ok: false, code: "upload_write_failed", detail: moved.failed };
  }

  /** One of a task's files as the download route serves it. */
  find(taskId: string, fileId: string): { path: string; name: string } | null {
    if (taskId === STAGED) return null;
    const row = this.store.find(taskId, fileId);
    return row === null ? null : { path: this.store.pathFor(row), name: row.name };
  }

  async forget(taskId: string): Promise<void> {
    if (taskId !== STAGED) await this.store.forgetSession(taskId);
  }

  /** Every task's files but those `kept` names; once, after restore. Staged ones are the store's own sweep's. */
  async sweep(kept: ReadonlySet<string>): Promise<void> {
    for (const owner of this.store.owners()) {
      if (owner !== STAGED && !kept.has(owner)) await this.store.forgetSession(owner);
    }
  }

  /** Each file this machine holds, copied in among the session's own to send; one it does not hold is left out. */
  async intoSession(taskId: string, files: readonly TaskFile[], sessionId: string): Promise<UploadRow[]> {
    if (this.sessions === null) return [];
    const rows: UploadRow[] = [];
    for (const file of files) {
      const held = this.store.find(taskId, file.id);
      if (held === null) continue;
      const copy = await this.sessions.keepCopy(sessionId, { path: this.store.pathFor(held), name: held.name, mime: held.mime, bytes: held.bytes });
      if (copy !== null) rows.push(copy);
    }
    return rows;
  }
}
