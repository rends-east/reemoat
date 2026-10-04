---
paths:
  - src/archive.ts
  - packages/web/src/ui/ImportCode.tsx
  - packages/web/src/importSkill.ts
---

## What this is

Code that is on somebody's laptop, with no remote, credential or push behind it, reaches
a machine the other way round: an agent **on the machine the code is on** packs it, and
`POST /fs/import` makes the archive one new folder inside the directory the picker is
standing in. It sits beside `POST /fs/mkdir` because it answers the same question (how a
folder worth starting a session in comes to exist) and there is no session yet.

## Containment, rebuilt for a path somebody else wrote

Every archive member is a path somebody else chose, used to *create* a file, and
`paths.ts` forbids authorising an action on one with its containment primitives
(`atOrUnderReal` was deleted rather than kept for this). So nothing here is a `realpath`
comparison:

- **`safeMemberPath` is pure and refuses first**: no filesystem, total over every string,
  run before anything is created. Both readers go through it.
- **`..` is refused, never normalised.**
- **A symlink member is refused in both formats** — zip's `S_IFLNK` in the top 16 bits of
  the external attributes (only when "made by" says UNIX), tar's typeflag `2` — and so
  are hardlinks, devices and fifos.
- **Nothing that already exists is ever opened.** Every member is written `"wx"`
  (`O_CREAT|O_EXCL`), as `Uploads.receive` does: never follows a link, never truncates, so
  a link planted after the check is an `EEXIST`.
- **`.git` is refused, case-folded with `toLowerCase()`**, the one refusal about this
  product. `git.ts` deletes `GIT_NO_EXEC_CONFIG`, so a repository's hooks and LFS filters
  run on `git worktree add`,
  so an imported `.git` would make an upload execute with nobody watching; and on a
  case-insensitive filesystem (APFS, NTFS) `.GIT/config` *is* `.git`, whose
  `core.fsmonitor` the `git status` in `changes.ts` would run, no executable bit needed.
  `importFolderName` and `settleFolderName` carry the same fold. Reversible in one
  clause, deliberately kept. The export skill excludes `.git`; history comes from asking
  the agent to clone.

## The target is untouched until the last moment

- Extraction goes into `<target>/.reemoat-import-<random>/tree/` and arrives by one
  `rename`; any failure leaves the picked folder exactly as it was. This is the only
  route that writes into a directory the daemon does not own.
- **Staging sits inside the target**, not under `~/.reemoat`: the final `rename` is then
  one filesystem (no `EXDEV`), and no third remover tree owes `scripts/daemon.ts` a
  proof that it nests with neither of the others.
- Everything below the staging directory is a path the daemon made, so plain filesystem
  calls are allowed there (`stall.ts`'s rule is for paths somebody else named; every
  path has passed `safeMemberPath`). `resolveCwd` on the target is the bounded half,
  `makeDir`'s call, unconfined for `makeDir`'s reason.
- **The destination is `lstat`ed before the rename, and anything there is a refusal**:
  `rename(2)` onto an empty directory succeeds by removing it, which this daemon may not
  decide to do. The errno mapping below is the backstop for the race.
- **`discardStaging` is the third `rm`**, guarded like the others (`lstat`, refuse a
  symlink, `containedIn`, remove), and runs on every path including success.
- **`sweepStaleStaging` is the fourth**, run on the way *into* an import (the daemon
  learns a target only when somebody names it). It removes only names this daemon
  generates — `/^\.reemoat-import-[0-9a-f]{16}$/` exactly — `lstat`-confirmed a directory
  (a symlink is neither followed nor removed), `containedIn` the target, older than an
  hour. `discardStaging` sits in a `finally` an OOM never reaches.
- **`settleFolderName` refuses that same pattern** for an archive's top-level folder, or
  the next import into the same folder would delete it.

## What each format costs

- **Read the zip central directory and nothing else.** The two copies of each member may
  disagree; the local header is read only for its own name and extra lengths, to find
  where the data starts.
- **The zip64 extra field is positional**: a member is present only when its 32-bit field
  is saturated, in fixed order, and the cursor advances by those present.
- **A zip name without general-purpose bit 11 is CP437 and is refused** (pure ASCII
  is the same in both, so only an ambiguous name is refused).
- **pax headers (typeflag `x`) are read, not refused** — bsdtar writes them routinely.
  GNU's `L` is handled the same way; `g` globals are skipped.
- **`./` is skipped, not refused** (`tar -czf x.tar.gz .` writes it first, and
  `safeMemberPath` alone answers `escapes_root`). `isArchiveRoot`
  is checked before the refusal in both readers and is `true` only for a name made
  entirely of `.` and separators; any `..` makes it `false`.
- **`__MACOSX/` and `.DS_Store` are skipped silently**, which the single-root rule needs:
  Finder's Compress writes a parallel tree beside the folder.
- **Bytes are charged as the decompressor produces them**, never from a declared size,
  and against *everything* produced: `Budget.countProduced` sits on the whole gunzip
  stream above tar parsing (header bodies, skipped `g` headers, a refused member's drain,
  padding); in zip it sits inside each member's pipeline. `countWritten` only reports and
  has no ceiling of its own.
- **A tar extended header is the one body read whole**, so `MAX_TAR_HEADER_BYTES` is
  checked before the read; unbounded, it stalls the event loop and exhausts memory.
- **`tarNumber` is forgiving, so its output is checked**: negatives parse, a malformed
  value truncates to a plausible one, base-256 reaches past `Number.MAX_SAFE_INTEGER`. A
  negative size desynchronises the block stream.
- **Never `handle.createReadStream` per member**: each registers a `close` listener on the
  shared `FileHandle` until the import ends. `readRange` reads positionally.

## The client

- **A `Sheet` on component state, not a route.** `App` draws overlays from the live
  route, so a nested route would unmount `NewSession` with the machine, agent and folder
  already chosen; Q7.69's case for routes does not transfer. `Sheet.onClose` makes every
  dismissal (Escape, ✕, scrim) land on the form behind it, and `webcheck` reads the
  props. Android's Back still pops `/new/…` and closes both: the accepted cost.
- **An old daemon is known by the shape of its refusal, never its version**: with no
  route it answers Hono's bare 404, which `parseBody` turns into `code === "http_404"`.
  `DAEMON_VERSION` is a label (`compatibility.md` rule 1), and a new client against an old
  daemon is this fleet's ordinary state.
- **The skill text is on screen, not only on the clipboard**: a bounded, scrollable
  `<pre>` with the copy icon in its corner. The box carries `overscroll-contain` (the
  sheet body is itself a scroller), and the button sits on the wrapper, not inside the
  scroller.
- **`onDragOver` must `preventDefault` or `drop` never fires.** The drop target is the
  whole sheet body, as `Composer`'s is the whole composer.
- **Nothing is drawn before the daemon answers**: the picker moves to
  `answer.import.path`, never to a name derived from the file sent.
- **The skill is a string constant, not an asset under `public/`** (nothing to 404), and
  a prompt containing the skill rather than a `SKILL.md`. `webcheck` holds that what it
  asks for is what `safeMemberPath` accepts; a skill asking for `.git` gets the whole
  archive refused.

## Bounds

| | |
|---|---|
| `MAX_IMPORT_BYTES` | 50 MiB on the wire. Not `MAX_UPLOAD_BYTES` (100 MiB), and neither is set by reading the other: this bounds what the daemon expands onto disk, up to `MAX_IMPORT_ENTRIES` files, each a containment decision and an inode |
| `MAX_IMPORT_UNPACKED_BYTES` | 500 MiB, charged against bytes actually produced. 10:1, where source gzips at about 4:1 and a bomb aims for 1000:1 |
| `MAX_IMPORT_ENTRIES` | 20 000; bytes cannot see an inode (`MAX_UPLOADS_PER_SESSION`'s argument) |
| `MAX_IMPORT_PATH_CHARS` / `MAX_IMPORT_DEPTH` | 1024 / 64, per member |
| Central directory | 16 MiB, its own ceiling: read whole, and sized by the archive rather than the entry cap |
| Concurrency | One import at a time (`409 import_busy`): no per-session accounting to fall back on, and the relay's 256 streams would be 12 GiB of archive |

## Known limitations

- Q7.62 applies: the body-cancel obligation hangs off the streaming exemption, so this
  route is covered without being told. What a parked sender costs a real tunnel is not
  measured.
- **No member CRC is verified**: corruption yields a silently wrong file, bounded and
  contained but unchecked.
- **An imported file loses its executable bit**: every member is written `0o600`, so a
  `gradlew` arrives non-executable. Deliberate for now, rather than honour a mode field
  somebody else wrote.
