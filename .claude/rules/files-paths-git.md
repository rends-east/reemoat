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

## Files

**A message may be text, files, or both.** The prompt route validates
`attachments` *before* `text`; empty with nothing attached is still refused, and
`session.ts` drops the text block entirely when there is no text. The client may
**not** synthesize "here is a file" to paper over the gap — that puts words in the
operator's mouth inside the model's context. Two consequences: `deriveSessionTitle`
reads the text alone, so a files-only first prompt leaves the session unnamed; and
`canSend` has to agree with the route or Send is enabled onto a `400`. Q2.29.

**In: a file is staged, then named by a prompt.**
`POST /sessions/:id/uploads?name=` streams a raw body to
`~/.reemoat/uploads/<sessionId>/<uploadId>/<name>`; `POST /sessions/:id/prompt`
then takes `{text, attachments: [uploadId, …]}`. Uploading happens **on select
rather than on send**, because the id has to exist before a prompt can name it.
Q2.30. Every attachment becomes a `resource_link` block with a `file://` URI — the
block that is never wrong, which is why **the paperclip needs no capability gate** —
with an `image` block of base64 bytes *on top* where the agent advertised
`promptCapabilities.image`, on top rather than instead so the agent can re-read the
file with its own tools. The upload root is outside the workspace, so claude asks
permission to read an attachment and nothing here suppresses it. Q2.31, Q2.33.
`acceptsImages` is deliberately **not** on `SessionSnapshot`; the honest home is
`inlined` on the recorded attachment. Q2.34.

**Out: any regular file under `workspace.root`, plus the session's own uploads.**
`GET /sessions/:id/files?path=` widens no authority — the agent can `cat` anything
under that root already — and `GET /sessions/:id/uploads/:uploadId` is not optional,
uploads living outside the workspace. Q2.35. The upload index is SQLite, because an
in-memory total resets on a restart and would defeat the per-session byte budget.
Q2.36.

**A name is sanitized where a path is refused.** An upload's name is a **label, not
a location** — the file is created inside a directory named by 64 fresh random bits,
so containment comes from the path and never from the name. What is still refused is
what is *dangerous*: control characters above all, because that string is echoed into
a `Content-Disposition` where a CR is response splitting. Q2.37.

**A download is `fetch` with the header into a `Blob`, never `<a href="…&token=">`** —
which would widen the `?token=` exception `readCredential` narrows to a request
carrying `upgrade: websocket`. Sending no `Access-Control-Expose-Headers` decides two
things: `Content-Disposition` is unreadable cross-origin, so the filename comes from
the requested path, and `Content-Length` **is** safelisted, so an oversized file is
refused before it is resident. Q2.38.

## Invariants

**Files, paths and the database**

- **No synchronous filesystem call on a path this daemon did not create.** A stalled
  network mount blocks inside the kernel: synchronously that stops the event loop —
  every session, every socket and `/health` — and asynchronously it costs a libuv
  threadpool slot for the life of the process. This is not about browsing: for a
  `plain` session `workspace.root` **is** the caller's own `cwd`, and `workspaceReady`
  saves nothing, since it probes the *root* while the stall is on a mount underneath.
  `stall.ts` owns the mechanism; what stays synchronous is either a path we made or
  sits behind a probe. `safeRelPath` is purely syntactic, `probeRequestable` is the
  async half, and `requestedPath` answers `503 path_unresponsive` on its `null` and
  `400 invalid_path` otherwise. In `GET /worktrees` an entry that does not answer is
  dropped from the listing. Q5.29, Q5.93.
  **A syntactic refusal about a path is only ever about the string somebody typed.**
  `safeRelPath` refuses a `.git` segment because `.git/config` carries remote URLs and
  the credential helper configuration, and one `g -> .git` link makes `?path=g/config`
  a request with no such segment, which containment then accepts. The test is re-run
  on the **resolved** path, in `probeRequestable`, that being the only function
  holding one. `O_NOFOLLOW` cannot help: it governs the leaf. Q7.85.
- **Containment has two forms, and using the lenient one for a trust decision is a
  hole.** `atOrUnder` compares the path *as written* when `realpath` throws — which it
  does for every file about to be created — so it is correct only where the path is
  *ours* and merely not created yet. Nothing else may use it to decide about a path
  somebody else chose, and there is exactly one containment primitive file. Q5.31,
  Q5.32.
- **Worktree creation is containment-checked, like removal always was**, and what it
  guards is the one `rmSync` in the codebase. Checked before the add and again after
  it, with the `repoKey` component `lstat`ed so a link is refused rather than
  followed, and the check must agree with `createWorkspace` about which root that is.
  **The two sides must also be in the same namespace** — it resolves the deepest
  component that *exists* and rebuilds the not-yet-created leaves onto that answer, or
  every `POST /sessions` throws `outside_worktree_root` wherever the worktree root
  traverses a symlink. Q5.36.
- **Two remover trees, and they must not nest.** If either root sat at or under the
  other, one remover could reach into the other's tree and neither guard would mean
  what it says. `daemon.ts` refuses to start on it; the upload sweep additionally
  `lstat`s each session directory, since an upload id is guessable from a transcript.
  Q5.74.
- **An oversized upload is refused on the header first, and the body is always
  cancelled** — unlink, then rmdir, then cancel. The running counter in
  `Uploads.receive` is the only bound on a request body anywhere in this system.
  **Cancelling matters more than the order**: the relay's window is granted on
  consumption, so a reader that stops parks the sender at 256 KiB, and the next valve
  is the tunnel's 8 MiB socket check — which closes the **whole tunnel for that
  machine**. Q5.72, Q5.73.
- **A downloaded file is never rendered, and two things enforce that.** The daemon
  sends `application/octet-stream` — always, never sniffed — plus `attachment`,
  `nosniff` and `no-store`; the client re-types the `Blob` before creating an object
  URL. Both halves are needed: a `blob:` URL carries the *client's* type and inherits
  the *creating* origin, whose `localStorage` holds `reemoat.credential`, and this
  route serves **any regular file under a session's workspace**, so a rendered HTML or
  SVG executes on the daemon's own origin. Never `window.open(blobUrl)`, never
  `target="_blank"` without `download`, never an `<iframe src=blobUrl>`. `daemoncheck`
  pins the pair the query credential rests on: the 401 on `/files?…&token=` and the
  still-working handshake. Q5.71.
- **Symlinks are never content-diffed.** `git diff --no-index` follows the link, so
  `ln -s ~/.ssh/id_rsa x` would serve the target's bytes to anyone holding the token.
  `lstat` first, always. **`FileChange.symlink` is a hint and `diffFile`'s own `lstat`
  is the guarantee** — an untracked path is a `?` record carrying no mode, so a
  symlink the agent just created is reported `symlink: false`. Q5.88, Q5.89.
- **The `--no-index` header rewrite replaces with a function, never a string.**
  `String.replace` expands `$&`, `` $` ``, `$'` and `$$`, and the replacement is a
  path the *agent* chose — spliced back into the one header that has to be right for
  `client diff … | git apply`. Q5.90.
- **Worktree removal refuses by default and prunes unconditionally.** `git worktree
  remove` says nothing about unpushed commits; that check is ours, and `@{upstream}`
  is the wrong tool because it throws when unset. `prune --expire=now` runs on *every*
  path including the failed ones, and **the unpushed-commits refusal does not depend
  on the directory existing** — a directory somebody already `rm`ed is exactly when
  the branch is the only copy. `null` from `count()`/`countStatus` means "could not
  tell" and must never read as zero: a timeout, a 128 off a stale gitfile, oversized
  output and a parse failure all collapse into it. Both are `counts_unknown` refusals
  (`about: "dirty" | "commits"`), and `--force` is the only way past. Q5.86, Q5.87,
  Q2.41.
- **A refused `git worktree remove` is not a licence to `rm` what it refused.** It
  matches git's **own words** (`contains modified or untracked files|use --force`, the
  technique `classifyAddFailure` already uses) rather than "the call failed", because
  the guarded `rm` still has a real job — a stale gitfile, an unregistered directory,
  half-written admin metadata. The refusal is `remove_refused` and carries git's
  stderr; the prune is skipped on that one path alone, safe because a worktree git
  just refused is still registered and still present. Q2.41.
- **The refusal's *sentence* is derived**, because one fixed sentence lied about the
  refusal that exists to say "I could not tell". `removalRefusalAnswer` keeps the 409
  and `--force` for every refusal and splits the code: `workspace_dirty` for a
  definite one — the string `scripts/client.ts` keys its hint on — and
  `workspace_uncertain` when only `counts_unknown` refusals are present. Q2.41.
- **The daemon lock is claimed before the schema is touched.** `migrate()` and
  `checkSchemaVersion` are permanent, so running them first upgrades the file under
  the daemon still running, which then cannot restart and has no down migration.
  Q5.35.
- **The database directory is chmodded, not just the file.** SQLite writes `-wal` and
  `-shm` beside it carrying the same transcript bytes; chasing those files loses
  because they are recreated, and `mkdirSync(mode)` applies its mode only to
  directories it created. Q5.91.
- **`title` and `pinned` are the only columns in the upsert's `DO UPDATE`.** `agent`
  and `created_at` are immutable identity, and an upsert that can rewrite them can
  corrupt a row it was only meant to touch. Q5.28.

## Layout

| File | Holds |
|---|---|
| `src/git.ts` | The git vocabulary: argv arrays, an env allowlist about determinism rather than confinement, timeouts, honest truncation. Installs **no** config — your hooks and LFS filters run |
| `src/worktree.ts` | Per-session worktrees: probe, create, list, inspect, remove |
| `src/uploads.ts` | Files staged for a prompt: the root, the streaming write, the sanitizer, the TTL sweep, the content blocks they become. Declares `UploadRow`/`UploadIndex` |
| `src/changes.ts` | What a session changed, and the diff for one file of it. Paths come out **relative to `workspace.root`**: git speaks repo-root-relative on both commands, `-z` is what makes `status` agree with `diff` (so `--relative` is the bug rather than the fix), and `repoPrefix`/`toWorkspaceRelative` translate once on the way out (Q7.90). Containment is the two halves above, `probeRequestable` answering `"ok" \| "escapes_tree" \| "git_dir" \| null` and `probeContained` being the two-answer form over it. `markBinary` runs after the file cap through `probeBinary`'s deadline, never as syscalls inside the parser (Q7.88) |
| `src/browse.ts` | Directory listing so a remote client can pick a `cwd`. `REEMOAT_ROOTS` narrows what is *listed* and nothing else; `resolveCwd` is deliberately unconfined |
| `src/stall.ts` | Asking the filesystem something that may never be answered: the bounded probe, the permit gate, the memory of which paths do not reply. `probeBinary` is git's own NUL heuristic through that deadline — git having listed a path says nothing about whether the next syscall returns (Q7.88). `probeRealpath` is the third answer beside `probeExists`/`probeFile` and the bounded form of `paths.ts`'s synchronous `resolved()`, reached everywhere a path somebody *else* named is resolved |
| `src/mounts.ts` | The kernel's mount table, and which filesystems answer over a network. Read from `/proc/self/mounts` or `mount(8)` — never `statfs`, which asks the server the question it is hanging on |
| `src/paths.ts` | `containedIn` / `atOrUnder`: realpath first, then compare segment-wise. The one containment primitive — and `containedInResolved` / `atOrUnderResolved`, the same segment-wise rule with the resolving already done, which is what an async caller compares two `probeRealpath` answers with rather than writing a second prefix test (Q5.100) |
| `packages/web/src/paths.ts` | `relativeTo` and `filenameFor`: the join between absolute agent paths and the workspace-relative path the download route takes |
| `packages/web/src/ui/download.ts` | `saveBlob`, and the one line in it that must never change |

## Bounds

| | |
|---|---|
| Changes API | 2000 files, 512 KiB per diff, both reported as `truncated` rather than silently short |
| git calls | 5s structural, 10s list, 15s status/diff, **120s** `worktree add` (hooks and LFS smudge are live on this path) |
| Uploads | 25 MiB per file, 10 per message, 100 MiB **and** 100 files per session (a byte cap cannot see a hundred thousand one-byte uploads, each a directory). 200 bytes of filename, 128 of mime. Inline images 5 MiB raw. Unconsumed uploads expire at 24h |
| Downloads | 100 MiB, **deliberately not the upload number**: that bounds what a client pushes onto your disk, this bounds a token-readable read of a whole workspace. The client refuses at the same number from `content-length` |

## Known gotchas

- **Rename field order is opposite between the two git commands we parse.**
  `status --porcelain=v2` emits `<newPath>` then `<origPath>`; `diff --raw -z` and
  `--numstat -z` emit `<srcPath>` then `<dstPath>`. A shared "read two path tokens"
  helper would invert every rename. Q6.30.
- **A porcelain-v2 `2` record spans two NUL-separated tokens** under `-z`. Consume the
  extra token or every later record shifts by one. Q6.31.
- **`git diff --no-index` exits 1 when the files differ** — the *success* case, and the
  path every newly created file takes. Q6.32.
- **`--ignored=matching`, never `traditional`.** Measured in this repo with `-uall`:
  6408 records against 2. Q6.33.
- **`rev-parse --show-toplevel` dies in a bare repo**, so the repo probe needs two
  calls. And `--git-common-dir` returns a *relative* `.git` without
  `--path-format=absolute`. Q6.34.
- **Even `-uall` collapses a nested repo** — git stops at any directory holding its own
  `.git` and emits one `? dir/` record. Those are flagged `collapsed`. Q6.35.
