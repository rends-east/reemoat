---
paths:
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/follow.ts
  - packages/web/src/ui/autosize.ts
  - packages/web/src/ui/Markdown.tsx
  - packages/web/src/ui/DiffView.tsx
  - packages/web/src/ui/AskCard.tsx
  - packages/web/src/ui/PermissionCard.tsx
  - packages/web/src/ui/ElicitationCard.tsx
  - packages/web/src/ui/Bubble.tsx
  - packages/web/src/ui/ImagePreview.tsx
  - packages/web/src/ui/links.ts
  - packages/web/src/diff.ts
  - packages/web/src/permission.ts
  - packages/web/src/ask.ts
  - packages/web/src/elicitation.ts
  - packages/web/src/preview.ts
  - packages/web/src/store.ts
---

**The transcript.** Agent output is markdown with raw HTML off (untrusted text quoting an
untrusted repository); a person's message is never markdown. `Markdown.tsx` is memoised on a
coalesced run's joined text. The ask card is `ask-card.md`'s; background work and subagents
are `background-work.md`'s.

**Markdown and messages**
- **Markdown keeps the list marker written.** mdast records neither `1)` nor `1.`, so
  `remarkListDelimiter` in `ui/mdlist.ts` reads it from `file.value` at
  `position.start.offset` and marks the list; `index.css` draws `counter(list-item)` on
  `::marker`. Its own module because `Markdown.tsx` cannot be imported offline.
  `list-decimal` stays on the element as the fallback; `start` is passed through.
- **A table cell keeps its words whole**: the body's `wrap-anywhere` is reset on `td`/`th`
  (`overflow-wrap: break-word; word-break: normal`), or min-content drops to one character
  and auto layout crushes a short column. An overlong token scrolls the table. Q3.704.
  A column whose every cell is at most `SHORT_CELL_CHARS` is `whitespace-nowrap`
  (`remarkShortColumns`, `ui/mdtable.ts`). A class against `${…}` is invisible to Tailwind's
  scan; `webcheck` sweeps for it. Q3.705.
- **A sent message not yet back is a row in the conversation**, from `echo.ts` through
  `SessionView`, never a bubble under the transcript, and drawn above the working line.
  Nothing says "sending"; a refusal puts the text back in the box with a toast. Keyed by
  session. Settled in `store.ts` in the commit its `prompt` event lands in (`claimEcho`), on
  the socket or in a history page, or by seq when the POST answers first. Q3.653. A request
  that fails in transit is `reach.md`'s (Q3.713).
- **A queued message says so.** A `prompt` whose seq is in the snapshot's `queuedPrompts`
  draws `Waiting for the agent to finish` under the bubble; nothing for a steered one. This
  is a daemon fact, not the `pending` marker `Bubble.tsx` forbids. `QueuedContext` carries
  it; `SessionView` memoises the set on the seqs, so its identity is stable.
  `mid-turn-messages.md`, Q3.601.
- **A person's message is drawn exactly as sent, never parsed**: `UserBubble`, each `@name`
  a button (Q3.682), `whitespace-pre-wrap wrap-anywhere`, no anchor; every row of a person's
  words is that component, with no `pending`. Reverses Q3.639. The composer sends `sentText`
  (surrounding blank lines and trailing whitespace go, indentation stays). The box never
  rewrites a keystroke: `VERBATIM_FIELD` and the shell's defaults. Q3.646, Q3.647.
- **A bubble is sized to its text**, `ui/hug.ts` (CSS `fit-content` leaves wrapped text at
  `max-w`): reset, then read, then write, never interleaved; one shared `ResizeObserver`
  watching each row; lines walked as text nodes. It declines attachments and images. It is
  the exception to `AppShell`'s no-layout-from-JS rule, bounded by Q3.637.
- **Only the text is selected**: `column-span: all` on the markdown body, the user bubble
  and the transcript column, plus `pre`, `td`, `th` inside them. All three placements are
  needed (a `flex` container between root and text restores the selection fill). Never a
  transform. `remarkListItemBlocks` marks a tight list item `spread`. No zero-width `::after`.
  Q3.638. A triple-click on inline code selects the span (`selectWholeSpan`). Q3.691. In a
  user's message the selectable element is a wrapper inside the padding, with `select-none`
  on the row and the padded box (`select-text` on the box does nothing; verify in a real
  `WKWebView`, since a programmatic `Range` ignores `user-select`). Q3.636.
- **Nothing outside this column takes a selection**: `body[data-app]` is `user-select: none`
  (on body, where every portal mounts; `gate.html` carries no `data-app`), and the column's
  `select-text` turns it back on. The other doors are `AskCard`'s context box and a text
  field, which keeps `text` from the engine's sheet and needs no rule. `webcheck` holds the
  files that turn it on as a census. A drag begun on chrome that reaches the column selects
  from the column's start, which is the engine's. Q3.717.
- **A link is drawn only where there is somewhere to go**: `openableHref` in `ui/links.ts`
  allows `http`, `https`, `mailto`, else `null` and plain text. Widening it launches a
  program named by an agent-chosen string; a workspace file goes through
  `GET /sessions/:id/files` with a header. Not the XSS guard: react-markdown empties
  `javascript:` upstream. Q3.300.
- **An image is drawn as text**: `Markdown.tsx` overrides `img` and binds no `src`, since
  react-markdown allows `https:` and an agent-chosen URL would be fetched on render from the
  origin holding `reemoat.credential`. The alt text stays; workspace images come through
  `ImagePreview` from a `Blob`. The CSP is defence in depth: `connect-src` is built from
  `relayUrl`, listing the relay's `wss` and `https` origins. Q7.86.

**What a row is**
- **The working line means the agent is working, turn or not** (`unpromptedSince`, Q2.233,
  timed from `workStartedAt`), and counts text and thoughts since the newest `tool_call`,
  `prompt`, `turn_end` or `context_cleared`, characters over four. `streamedSinceTool` is one
  step a token, handed to the foot alone. Drawn, never spoken (`aria-live`). Q3.644. Its room
  is kept while silent, `keepsFootSlot` (Q3.653).
- **A stopped turn says so in words**: `stopReasonText` and `resolvedByText` in `tail.ts`,
  `exitText` in `bits.tsx`. `cancelled` takes `WaitingFoot`'s shape (`WorkingMark still`,
  `text-danger`) in the working line's row; other reasons are a centred line. Every table
  falls through to the identifier for an unknown value. `taskFloor` keys on
  `stopReason !== "end_turn"` alone.
- **`showsInTranscript` refuses status lines, workspace rows and `turn_end: end_turn`**;
  other stop reasons stay, except `agent_error`, whose rejection is the row above. It still
  raises `taskFloor`, which runs before the gate; `webcheck` pins the pair. Q2.218.
- **A run of agent text is keyed on `messageId`** as well as `role` and `thought`, since
  parts join with no separator. The daemon numbers what the agent did not: the first id
  latches, then an unnumbered message gets a `~`-prefixed id; an agent numbering nothing
  keeps `null`. Q3.604.
- **A stopped task's notice is a row, not prose**: `stopsTask` matches an agent run under a
  `~` id that is the daemon's `1 task stopped` or opens with the adapter's sentence (a line
  logged before the daemon reworded it); `buildTail` emits a `StoppedNode`, folding stops
  with nothing drawn between them into one count keyed on the oldest. `StoppedRow` is the
  working line's button (`TASK_DOOR`, one string for both) and opens `TaskPanel`. Q2.257.
- **A thought is not drawn**, suppressed in `tail.ts`, and still flushes the run.
  `buildTail` flushes the text run only for events not in `TRANSCRIPT_SILENT` — keyed on the
  set, never `showsInTranscript` (`turn_end: end_turn` is a boundary); `webcheck` fails both
  ways. Q3.100.
- **A request and its answer collapse to one row**, keyed on whether an answer exists, never
  the request's `decision` (null for its whole life). A question is drawn as an exchange, an
  approval as one line.
- **A settled question draws what was asked**: `ElicitationResolvedEvent` carries
  `message` and `{key, label, value}`, and `answeredQuestions` recovers each question's
  wording from the arguments of the call `askedThrough` merges away, joining by identity on
  the chosen label, never by parsing `question_0` / `<question>__other`; a label two
  questions share matches neither. Joined in `tail.ts` as `EventNode.asked`; `null` draws as
  before (call outside the window, `rawInput` the `{truncated, bytes}` stand-in, or not an
  `AskUserQuestion`). cursor's `ask_question` reads alike (`askedInput`); its call, the
  daemon's yes and a late answer's `answers` prompt draw nothing. Q2.251.
- **Consecutive plan updates are one card where the newest landed**: `planFloor` in
  `buildTail`, consecutive over emitted nodes (one compare on `collected.length`). `flush()`
  runs first, so a message between two plans keeps both. `plan` stays out of
  `TRANSCRIPT_SILENT`. No absorbed count. The row is keyed on the newest seq, so the plan arm
  may hold no component state. Q3.455.
- **A run of consecutive tool rows is one row**: `foldRuns` makes a `GroupNode` whose
  sentence (`runSummary`) has clauses from ACP's `kind` in first-appearance order and
  `+N −M`. A run of one is never wrapped. Open is three-valued: `null` follows whether the
  run has finished; a tap outranks that for good. A failure does not open it: `1 failed`
  rides the collapsed row as bare `text-muted` text, never a `Badge` (whose plain tone is
  `bg-raised`); a bare `ToolCall` opens itself on failure. Re-measure in an effect on
  `open`, not the tap handler. Q3.105. A run never swallows a refusal or an unclassifiable
  answer, an unanswered request, any question, a subagent, an orphaned failed update, or a
  non-tool-call; each breaks it. A top-level call that never finished and has a turn end or
  agent start after it is `turnEnded`: not live, drawn `Minus` (Q3.702). An approval folds,
  with `N approved`. The verdict comes from `permissionDecisions`, never `outcome`
  (`selected` includes every `reject_*`); unknown is not foldable. Q3.106.
- **A file change draws a diff with the client's own counts.** `diffLines` in
  `packages/web/src/diff.ts` is the package's one line-diff, shared by the transcript and
  the approval card via `ui/DiffView.tsx`: a trim plus a bounded LCS (codex sends whole
  files). Counts come from the event; `GET /sessions/:id/changes` is not called. Accepted: a
  claude `Write` reports `oldText: null` when overwriting; an event clipped by the 128 KiB
  cap makes `unavailable` refuse a diff and `changeCounts` answer `null`, never 0. Q3.104.
  kimi's `diff` + `fs_write` pair is one row: matched on the path, one credit per absorbed
  change, one direction only, never on content (Q3.108). `DiffView`'s body paints
  `bg-surface` inside a `raised` frame; on `raised` the tints are invisible.
- Machinery is `text-fg/85`, failures included; the `X` at full `fg` and `N failed` carry a
  failure. A permission row reserves the kind-glyph slot empty. Q3.207.
- **A title is clipped in code, only when the clip pays for a line** (`truncate` loses "was
  anything cut"): `TITLE_CHARS` 80, `TITLE_OVERFLOW_MIN` 20; the body opens to the full
  title. `headlineWorthDrawing`: a value whose first 24 characters appear in the title is an
  echo. Q3.208.
- A download button draws nothing for a location outside the workspace: not disabled, no
  toast. It is `EventList.tsx`'s.

**Loading**
- **A conversation loads whole, from the top.** No render window: `loadAll` pages backwards
  at `EVENTS_PAGE_LIMIT` until the log's start, the agent's `/clear`, or 16 MiB; no per-run
  budget, no fetch-more control. `sameNode` pays for it; `decisions` is a context, not a prop.
  Q3.114. `MAX_TRANSCRIPT_BYTES` (16 MiB) is the only ceiling on one conversation, with no
  event count; `MAX_HELD_TRANSCRIPTS` (12) caps the tab in `trimTranscripts`, never evicting a
  live stream. `HISTORY_PAGE`/`EVENTS_PAGE_LIMIT` are 5000; `EVENTS_PAGE_BYTES` (768 KiB,
  coupled to `STREAM_WINDOW_BYTES`) bounds a page. `historyRetry` is a failed page's cost.
- **A cold load says so**: `reattachSince(null, …)` attaches at the tail, so history comes
  over HTTP; `TranscriptSkeleton` is keyed on `unfetched > 0`, never `loadingHistory`.
  `SessionView` draws the same before its row lands (`missingRowReason`, `AppState.listed`).
  Q3.419.
- **The only cut is the agent's, and nothing offers to undo it**: `buildTail`'s third
  argument `cut` is the newest `context_cleared`, strictly below the marker, so the marker is
  the top row and draws both the command (`UserBubble`) and a hairline *Context cleared*
  (`clearContext` alone emits it; `server.ts` reaches it only on that exact string). No
  reveal control or `revealedBeforeClear` (Q3.582): `loadStop` stops at `clearedAt`,
  `nextCut` answers one number, `transcriptNotice` is silent under a cut.
- **A gap is only one the daemon reported**, never one the client invented. Retention loss
  is a top line from `daemonFirstSeq` and `loadedFrom`, never a `GapMarker`, drawn only once
  paging reached the floor (`unfetched === 0`). Q3.46, Q3.47.
- **`transcriptNotice` in `store.ts` is the one answer to why a conversation does not start
  at its beginning**: `skeleton`, `loading`, `stalled`, `ceiling`, `floor`, `empty`.
  `EventList` draws exactly that, one string feeding the `role="status"` region too. It
  reads the same five `Transcript` fields as `loadStop`; `webcheck` asserts totality over a
  720-state grid. Q3.112.
- **Only the reader takes the conversation off its foot**, `ui/follow.ts`
  (`followsAfterScroll`, `useFollow`): every commit, an observer on box and content, and
  every scroll event pin it before paint. A move is judged from where the box was left. A
  send lands at the foot. A resize writes the offset through (`resync`, Q3.664);
  `[overflow-anchor:none]`. Q3.648. Wrapping moves nothing: `fitToContent` holds the form's
  height when measuring; the ask card reports in layout effects. Q3.649.

**Bounds.** Transcript diff: 250 000 LCS cells (`MAX_LCS_CELLS`) after the trim, past which
one replacement block marked `wholeFile` (Q3.104); 60 drawn lines per file
(`DIFF_MAX_LINES`), `omitted` carrying the rest, counts staying true totals; 2 context lines
(`DIFF_CONTEXT`); a word-level mark dropped past 60% of its line (`MAX_MARK_SHARE`, Q3.301);
400 chars (`MAX_MARK_CHARS`) the longest pair compared by character. `changeCounts` memoises
in a `WeakMap` keyed on the event, so `buildTail` may ask on every token.
