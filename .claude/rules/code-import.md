---
paths:
  - src/archive.ts
  - packages/web/src/ui/ImportCode.tsx
  - packages/web/src/importSkill.ts
---

## Why this exists

Until this route, code reached a machine three ways: it was already there and you
browsed to it, the agent cloned it itself, or it arrived as a ≤25 MiB attachment
staged **outside** every workspace on purpose. None of those is "the repository is
on my laptop and I want an agent on it" — cloning needs a remote, a credential on
that host, and a repository somebody has pushed.

So the flow runs the other way: an agent **on the machine the code is on** packs
it, and `POST /fs/import` takes the result and makes it one new folder inside the
directory the picker is standing in. It is registered beside `POST /fs/mkdir`
because it answers the same question — *how does a folder worth starting a session
in come to exist* — and because there is no session yet to hang it off.

## The one rule everything here follows

**Every path in an archive is a path somebody else chose.** Everywhere else in
this daemon a path is either one it created or one a person picked out of a
listing of what already exists. An archive member is a string written by whoever
built the archive and it is used to create a file, and `paths.ts` is explicit that
none of the containment primitives may be used to authorise an action on one —
`atOrUnderReal` was deleted rather than kept for a caller like this.

So containment here is **not** built out of `realpath` comparisons at all.

- **`safeMemberPath` is pure and refuses first.** It touches no filesystem, so it
  is total over every string and a driver holds hostile input against it with no
  temp directory; and it runs before anything is created, so the decision is made
  while there is still nothing to undo. **Both readers go through it**, which is
  what stops zip and tar drifting into disagreeing about what is safe.
- **`..` is refused, never normalised.** A member reading `a/../../x` is not
  asking for `x`, it is probing for whether this code normalises. Normalising is
  how every surviving zip-slip works — the check runs on the pretty form and the
  write runs on the raw one. There is no pretty form here.
- **A symlink member is refused, in both formats** — zip's `S_IFLNK` in the top
  16 bits of the external attributes (only when "made by" says UNIX), tar's
  typeflag `2`. So are hardlinks, devices and fifos. Once the extractor is
  otherwise clean this is the whole remaining attack: write `link -> /`, then
  write `link/etc/passwd`.
- **Nothing is ever opened that already exists.** Every member is written `"wx"`
  (`O_CREAT|O_EXCL`), the same flag `Uploads.receive` uses, which never follows a
  link and never truncates. A link planted between the check and the write is an
  `EEXIST`, not a write through it.
- **`.git` is refused**, and it is the one refusal that is about this product
  rather than about archives. The daemon runs `git worktree add` on the directory
  somebody picks, and `git.ts` deletes `GIT_NO_EXEC_CONFIG` on purpose so a
  repository's own `post-checkout` and its LFS filters run — as you. That is
  right for a repository *you* cloned. An imported one would make "upload a file"
  mean "the daemon executes what was in that file", with no agent in between and
  nobody watching, which is the shape every other path here avoids. Nothing
  legitimate is lost: the export skill excludes `.git`, and somebody who wants
  history asks the agent to clone, which is on screen while it happens.
  **Reversible — one clause — but deliberately.**

## The target is untouched until the last moment

Extraction goes into `<target>/.reemoat-import-<random>/tree/` and arrives by one
`rename`. An import that fails at any point leaves the folder somebody picked
exactly as it was, which matters more here than anywhere else: this is the only
route that writes into a directory the daemon does not own.

**Staging sits inside the target, not beside the worktree and upload roots**, for
two reasons that are both requirements. The final `rename` is then within one
filesystem by construction, where a root under `~/.reemoat` would be an `EXDEV`
copy for anybody whose projects live on another volume. And a third remover tree
would owe `scripts/daemon.ts:308` a proof that it nests with neither of the other
two.

**Because the daemon created the staging directory, everything below it is a path
it made** — which is what lets this file make ordinary filesystem calls. The rule
about bounding them through `stall.ts` is about paths somebody *else* named, and
by then every path has been through `safeMemberPath` and is rooted in a directory
with a random name. `resolveCwd` on the target is the bounded half, and it is
`makeDir`'s call, unconfined for `makeDir`'s reason.

**The destination is checked with `lstat` before the rename, and anything there at
all is a refusal.** `rename(2)` is not uniform: measured on macOS, a destination
that is a file or a symlink fails `ENOTDIR`, a non-empty directory fails
`ENOTEMPTY`, and an **empty directory succeeds** — implicitly `rmdir`ing it. That
last one loses no data but is a removal of a directory this daemon did not create,
which is precisely what it may not decide to do. The errno mapping below it is the
backstop for the race, not the rule.

**`discardStaging` is the third `rm` in this codebase** and is guarded like the
other two rather than on the strength of having just made the directory: `lstat`,
refuse a symlink, `containedIn`, then remove. It runs on every path including the
successful one.

## Facts about the formats, each of which cost a measurement

- **Read the zip's central directory and nothing else.** A zip states every member
  twice and the two copies are allowed to disagree, because nothing checks them
  against each other. Every extractor ever walked past a check was walked past it
  by validating one copy and reading the other. The local header is consulted for
  exactly one thing: its own name and extra lengths, which is the only way to know
  where the data starts.
- **The zip64 extra field is positional.** Its members are present only when the
  corresponding 32-bit field is saturated, always in the same order, so the cursor
  advances by whichever ones were actually needed. Reading it at fixed offsets
  yields a garbage offset out of a valid archive.
- **A zip name without general-purpose bit 11 is CP437, and is refused.** Decoding
  it as UTF-8 anyway turns undecodable bytes into U+FFFD, collapses distinct names
  onto one, and does it silently — a check that passes on one string while a file
  is created at another. Pure ASCII is identical in both, so only a genuinely
  ambiguous name is ever refused.
- **pax headers are read, not refused.** macOS ships bsdtar, which writes an
  extended header (typeflag `x`) ahead of members whose metadata does not fit the
  1979 layout, routinely rather than rarely. Refusing them refuses most archives
  made on a Mac. GNU's older `L` is handled the same way; `g` globals are skipped.
- **`__MACOSX/` and `.DS_Store` are skipped silently.** Not safety — correctness,
  and load-bearing for the single-root rule: Finder's Compress writes a parallel
  resource-fork tree beside the folder, so *every* zip made on a Mac has two
  top-level directories.
- **The bytes are charged as the decompressor produces them**, never from the
  declared size. A member's declared length was written by whoever built the
  archive; only the decompressor's output is a number nobody else chose. That is
  the whole bomb guard.
- **Never `handle.createReadStream` per member.** Each call registers a `close`
  listener on the shared `FileHandle`, so a zip of twenty thousand members
  registers twenty thousand of them and releases none until the import ends. Node
  warns at eleven, which is how this was found. `readRange` reads positionally and
  has no such bookkeeping.

## The client

**A `Sheet` stacked on component state, where every other pop-up in this app is a
route.** Q7.69 is right that a URL buys a deep link, a surviving reload and a free
Back button — and it does not transfer here: `App` draws the overlay from the
*live* route, so a nested route would unmount `NewSession` and take the machine,
agent and folder already chosen with it. This is a step inside a form, not a
destination, and the archive is on somebody's disk rather than in the URL. Escape
still works for nothing: `Sheet` registers with `useDismissible` and `overlay.ts`
gives the key to the most recent layer. **What is lost is Android's Back closing
only this one**, and that is the cost being accepted.

**An old daemon is detected by the shape of its refusal and never by its version.**
A daemon with no such route answers Hono's bare 404, which `parseBody` turns into
`code === "http_404"` — no envelope, so no code of this system's own. That *is* the
feature detection, because `DAEMON_VERSION` is a label and rule 1 of
`compatibility.md` is that nothing branches on one. The client ships inside the
control plane's image and is handed to everyone weekly while daemons update
whenever their owner runs `deploy.sh`, so new-client-against-old-daemon is the
ordinary state of this fleet, not an edge.

**The skill text is on screen, not only on the clipboard.** What step one asks
somebody to paste is an instruction that will read their repository and write
files; a button whose only account of itself is the word "copy" asks them to take
that on trust, and it is the failure nobody reports — you do not complain about a
block of text you were never shown. So it is rendered in a bounded, scrollable
`<pre>` with the copy control as an icon in its corner. The one comparable shape in
this app, the one-time secret, already shows the value rather than describing it.
Two details are load-bearing: **`overscroll-contain`**, because the sheet body is
itself a scroller and without it reaching the end of the box starts moving the
sheet — the nested-scroller failure `DirectoryPicker` describes; and the button
living on the **wrapper** rather than inside the scroller, so it stays put while
the text moves under it.

**`onDragOver` must `preventDefault` or `drop` never fires** — the browser's
default is to refuse the drop, and the symptom is a handler that looks unwired.
The drop target is the whole sheet body rather than the dashed box: the box says
where to aim, the body catches everything that misses. Same reasoning as
`Composer`'s drop being on the whole composer.

**Nothing is drawn before the daemon answers.** The picker moves to
`answer.import.path` — the path the daemon says exists — never to a name derived
from the file that was sent.

**The skill is a string constant, not an asset under `public/`.** An asset is a
request, a request is a URL, and a URL is a thing that can 404 in a deployment
nobody checked. It is also a *prompt containing the skill* rather than a
`SKILL.md` to download and place, so step one is one copy button on a phone.
`webcheck` holds it to the one property that matters: that what it asks for is
what `safeMemberPath` will accept — a skill telling somebody to include `.git`
produces an archive refused whole, and the only symptom is a 400 at the end of the
slowest step.

## Bounds

| | |
|---|---|
| `MAX_IMPORT_BYTES` | 50 MiB — the archive on the wire. **Deliberately not `MAX_UPLOAD_BYTES`**, whose own comment places 25 MiB "below anything that is a transfer rather than an attachment". This is that transfer |
| `MAX_IMPORT_UNPACKED_BYTES` | 500 MiB — what it may become, charged against bytes actually produced. 10:1, where source text gzips at about 4:1 and a bomb aims for 1000:1 |
| `MAX_IMPORT_ENTRIES` | 20 000 — bytes cannot see an inode, the argument `MAX_UPLOADS_PER_SESSION` already makes |
| `MAX_IMPORT_PATH_CHARS` / `MAX_IMPORT_DEPTH` | 1024 / 64, per member |
| Central directory | 16 MiB, its own ceiling because it is the one structure read whole and it is sized by the archive rather than by the entry cap |
| Concurrency | **One import at a time, per app.** This route has no per-session accounting to fall back on, and the relay allows 256 streams — which would be 12 GiB of archive and 125 GiB of unpacked tree. A person imports a codebase about as often as they start a project, so the bound is arrival rather than size, and `409 import_busy` is a better answer than a full disk |

## Known limitations

- **A daemon restart mid-import leaves a `.reemoat-import-*` directory behind.**
  It is dot-prefixed so `/fs/list` hides it, and it is named unmistakably. The
  alternative — sweeping directories the daemon does not own — is worse than the
  defect, so this is accepted rather than fixed.
- **Q7.62 applies here too, and is still unmeasured.** This route stacks the same
  auth and scope middlewares above the same body-cancel discipline as the upload
  route, so whether a refusal past those middlewares really does release the
  stream is the same open question, now asked in two places.
