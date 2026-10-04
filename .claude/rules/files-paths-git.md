---
paths:
  - src/changes.ts
  - src/worktree.ts
  - src/uploads.ts
  - src/stall.ts
  - src/paths.ts
  - src/mounts.ts
  - src/git.ts
  - src/browse.ts
  - packages/web/src/paths.ts
  - packages/web/src/ui/download.ts
  - packages/web/src/ui/files.ts
---

## Files in and out

- **A message may be text, files, or both.** The prompt route validates `attachments`
  before `text`; empty with nothing attached is refused; `session.ts` drops an empty text
  block. The client never synthesizes "here is a file". A files-only first prompt leaves
  the session unnamed (`deriveSessionTitle`), and `canSend` must agree with the route.
  Q2.29.
- **In: staged on select, then named by a prompt.** `POST /sessions/:id/uploads?name=`
  streams to `~/.reemoat/uploads/<sessionId>/<uploadId>/<name>`;
  `POST /sessions/:id/prompt` takes `{text, attachments: [uploadId, …]}`. Each attachment is a
  `resource_link` with a `file://` URI, so the paperclip needs no capability gate, plus an
  `image` block on top where the agent advertised `promptCapabilities.image`. claude asks
  permission to read the upload root and nothing suppresses it. `acceptsImages` is not on
  `SessionSnapshot`; it is `inlined` on the attachment. Q2.30, Q2.31, Q2.33, Q2.34.
- **A session keeps its newest files**: budgets roll, dropping the oldest already sent;
  an agent's images roll on their own. A dropped file answers 404 `upload_not_found`,
  drawn as *"… is no longer kept."* An untyped upload takes one read off its first bytes,
  and the web client sends a file's own type over the relay. Q2.247.
- **`send_file`** copies any file the agent can read into the upload store as an `f_` row
  and puts `file_sent` in the transcript (`agent-messaging.md`, Q2.252). `probeRealpath`
  carries the errno, so a closed folder is never "missing"; all of `/proc` is refused, by
  path and again by the opened descriptor's device (a thread's or the parent's `environ`
  holds the token too). Q2.253.
- **Out: any regular file under `workspace.root`** (`GET /sessions/:id/files?path=`,
  widening no authority) **and the session's uploads**
  (`GET /sessions/:id/uploads/:uploadId`; they live outside it). Q2.35. The upload index
  is SQLite so the per-session byte budget survives a restart. Q2.36.
- **An upload's name is a label, not a location**: the directory is 64 fresh random bits.
  Control characters are still refused; the name is echoed into `Content-Disposition`.
  Q2.37.
- **A download is `fetch` into a `Blob`, never `<a href="…&token=">`**: `readCredential`
  allows `?token=` only with `upgrade: websocket`. No `Access-Control-Expose-Headers`, so
  the filename comes from the requested path, and the safelisted `Content-Length` refuses
  an oversized file before it is resident. Q2.38.

## Invariants

- **No synchronous filesystem call on a path this daemon did not create.** A stalled
  network mount stops the event loop and `/health` (synchronously) or holds a libuv
  threadpool slot forever (asynchronously). Not only browsing: a `plain` session's `workspace.root` is the
  caller's `cwd`, and `workspaceReady` probes only the root. `stall.ts` owns the
  mechanism. `safeRelPath` is syntactic, `probeRequestable` the async half;
  `requestedPath` answers `503 path_unresponsive` on `null`, else `400 invalid_path`.
  `GET /worktrees` drops an entry that does not answer. Q5.29, Q5.93.
- **A syntactic refusal is only about the typed string**: `safeRelPath` refuses a `.git`
  segment, and `probeRequestable` re-runs the test on the resolved path (a `g -> .git`
  link). `O_NOFOLLOW` governs only the leaf. Q7.85.
- **Containment has two forms.** `atOrUnder` compares as written when `realpath` throws,
  so it is only for paths that are ours and not yet created, never a trust decision about
  one somebody else chose. One containment primitive file. Q5.31, Q5.32.
- **Worktree creation is containment-checked like removal**, guarding the one `rmSync`:
  before and after the add, with the `repoKey` component `lstat`ed (a link refused),
  agreeing with `createWorkspace` about the root. Both sides in one namespace: resolve the
  deepest existing component and rebuild the uncreated leaves onto it, or a symlinked
  root makes every `POST /sessions` throw `outside_worktree_root`. Q5.36.
- **Remover trees must not nest** (`plugins.md` adds a third); `daemon.ts` refuses to
  start on it. The upload sweep also `lstat`s each session directory, upload ids being
  guessable. Q5.74.
- **An oversized upload is refused on the header first, and the body is always
  cancelled** — unlink, rmdir, cancel. `Uploads.receive`'s counter is the only
  request-body bound in the system. Cancelling matters most: a stopped reader parks the
  sender at 256 KiB, and the 8 MiB socket check then closes the machine's whole tunnel.
  Q5.72, Q5.73.
- **A downloaded file is never rendered.** The daemon always sends
  `application/octet-stream` (never sniffed), `attachment`, `nosniff`, `no-store`; the
  client re-types the `Blob` before creating an object URL, which inherits the origin
  holding `reemoat.credential`. Never `window.open(blobUrl)`, never a `blob:` URL behind
  `target="_blank"` (only with `download`; `webcheck` pins every `_blank` anchor), never
  an `<iframe src=blobUrl>`. `daemoncheck` pins the 401 on `/files?…&token=` and the
  still-working handshake. Q5.71.
- **Symlinks are never content-diffed** (`git diff --no-index` follows them, so
  `ln -s ~/.ssh/id_rsa x` would serve the key); `lstat` first. `FileChange.symlink` is a hint and `diffFile`'s own `lstat` the guarantee: an
  untracked `?` record carries no mode. Q5.88, Q5.89.
- **The `--no-index` header rewrite replaces with a function, never a string**:
  `String.replace` expands `$&`, `` $` ``, `$'`, `$$` in an agent-chosen path. Q5.90.
- **Worktree removal refuses by default and prunes unconditionally.** The
  unpushed-commits check is ours (`@{upstream}` throws when unset) and does not need the
  directory to exist. `prune --expire=now` runs on every path but `remove_refused`.
  `null` from `count()`/`countStatus` means "could not tell", never zero; both are
  `counts_unknown` refusals (`about: "dirty" | "commits"`), `--force` the only way past.
  Q5.86, Q5.87, Q2.41.
- **A refused `git worktree remove` is not a licence to `rm`.** Match git's own words
  (`contains modified or untracked files|use --force`, as `classifyAddFailure` does);
  answer `remove_refused` with git's stderr. `removalRefusalAnswer` keeps the 409 and
  `--force` and splits the code: `workspace_dirty` for a definite refusal (what
  `scripts/client.ts` keys on), `workspace_uncertain` when only `counts_unknown`. Q2.41.
- **The daemon lock is claimed before the schema is touched**: `migrate()` and
  `checkSchemaVersion` are permanent. Q5.35.
- **The database directory is chmodded, not just the file** (`-wal`/`-shm` are recreated;
  `mkdirSync(mode)` applies only to directories it creates). Q5.91.
- **Identity is absent from the upsert's `DO UPDATE`**: never `agent`, `created_at`,
  `custom_agent`. It carries mutable preferences (`title`, `pinned`, `ultracode`, `rank`,
  `nickname`) and derived runtime state; state it as that property, not a list. Q5.28.

## Layout

| File | Holds |
|---|---|
| `src/git.ts` | Argv arrays, an env allowlist for determinism (not confinement), timeouts, honest truncation. Installs **no** config |
| `src/worktree.ts` | Per-session worktrees: probe, create, list, inspect, remove |
| `src/uploads.ts` | The root, streaming write, sanitizer, TTL sweep, content blocks, the three rolling budgets, `sniffImageMime`, `UploadRow`/`UploadIndex` |
| `src/changes.ts` | Changes and one file's diff, relative to `workspace.root`: `-z` makes `status` agree with `diff` (`--relative` is the bug); `repoPrefix`/`toWorkspaceRelative` translate once (Q7.90). `probeRequestable` answers `"ok" \| "escapes_tree" \| "git_dir" \| null`, `probeContained` is its two-answer form. `markBinary` runs after the file cap via `probeBinary`, never in the parser (Q7.88) |
| `src/browse.ts` | Listing for picking a `cwd`. `REEMOAT_ROOTS` narrows the listing only; `resolveCwd` is unconfined |
| `src/stall.ts` | The bounded probe, permit gate, memory of silent paths. `probeBinary` is git's NUL heuristic under the deadline (Q7.88). `probeRealpath` (beside `probeExists`/`probeFile`) is the bounded `resolved()` for any path somebody else named; `probeBuild` adds a `stat`, compared by `LocalRuntime.agentCli` on every use (Q6.112) |
| `src/mounts.ts` | Which filesystems are network ones, from `/proc/self/mounts` or `mount(8)`, never `statfs` |
| `src/paths.ts` | `containedIn` / `atOrUnder` (realpath, then segment-wise) and `containedInResolved` / `atOrUnderResolved` for two `probeRealpath` answers (Q5.100) |
| `packages/web/src/paths.ts` | `relativeTo`, `filenameFor`: agent paths to the download route's relative path |
| `packages/web/src/ui/download.ts` | `saveBlob`, and the one line in it that must never change |

## Bounds

| | |
|---|---|
| Changes API | 2000 files, 512 KiB per diff, both reported `truncated` |
| git calls | 5 s structural, 10 s list, 15 s status/diff, **120 s** `worktree add` |
| Uploads | **100 MiB per file**, 10 per message. A session keeps **1 GiB** *and* 100 files, dropping the oldest sent, never one still waiting. Agent images **200 / 256 MiB** (`roomFor`, Q2.247); sent files **100 / 1 GiB**, 100 MiB each, own rate window (Q2.252). **300 MiB / 5 min** per session: `429 upload_rate_limited` with `Retry-After`. 200 bytes of filename, 128 of mime. Inline images 5 MiB to the agent, 25 MiB from one (`MAX_AGENT_IMAGE_BYTES`). Unconsumed uploads expire at 24 h |
| Downloads | 100 MiB, equal to the upload cap by coincidence; neither is set from the other. `MAX_SENT_FILE_BYTES` is coupled: `daemoncheck` holds it at or under this. The client refuses at the same number from `content-length` |

nginx's default `client_max_body_size` (1 MB) answers a 413 the daemon never sees;
`deploy/` ships no proxy and `deploy/README.md` names the value.

## Git gotchas

- **Rename order is opposite**: `status --porcelain=v2` emits `<newPath>` then
  `<origPath>`; `diff --raw -z` and `--numstat -z` emit `<srcPath>` then `<dstPath>`.
  Q6.30.
- **A porcelain-v2 `2` record spans two NUL-separated tokens** under `-z`. Q6.31.
- **`git diff --no-index` exits 1 when the files differ**, the success case. Q6.32.
- **`--ignored=matching`, never `traditional`.** Q6.33.
- **`rev-parse --show-toplevel` dies in a bare repo**; `--git-common-dir` is relative
  without `--path-format=absolute`. Q6.34.
- **Even `-uall` collapses a nested repo** into one `? dir/` record, flagged `collapsed`.
  Q6.35.
