---
paths:
  - src/nickname.ts
  - src/registry.ts
  - src/peers/hub.ts
  - src/peers/envelope.ts
  - packages/web/src/nickname.ts
  - packages/web/src/mentions.ts
  - packages/web/src/ui/MentionMenu.tsx
  - packages/web/src/ui/MentionLink.tsx
  - packages/web/src/mentionLinks.ts
  - packages/web/src/ui/Composer.tsx
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/SessionBrowser.tsx
  - packages/web/scripts/webcheck.nicknames-and-mentions.ts
---

# Nicknames, and what `@` names

**The title says what a session is about** (first message, or a person's rename) and
leads the list and header. **The nickname is its address** — `mira`, what follows `@`
and what agents call it — drawn as `@mira` heading the row's subline and the header's
subtitle (`nicknameLine`). `sessionLabel` and Rename are unchanged. Q3.677.

## What a nickname is (Q2.245)

- **One shape, written twice**: `src/nickname.ts` and its mirror
  `packages/web/src/nickname.ts`; `webcheck` compares `NICKNAMES` and every verdict.
  Lowercase latin, digits, single hyphens, a letter first, 2–32 characters. **No
  underscore, ever**: `PeerHub.resolve` reads one as a session id. Every daemon's
  `isPeerName` accepts the shape.
- **One per machine, over every row held, ended ones included**, by reservation:
  `reserveNickname` runs synchronously at the top of `create`, before the capacity check,
  the create token and `createWorkspace`, released in a `finally`. No UNIQUE index (`put`
  swallows errors).
- **Always present**: an unnamed create takes `pickNickname`; `restore()` names older rows
  synchronously, oldest first (the older duplicate keeps its name). Never cleared; `/meta`
  refuses `null`.
- **It is the peer name** (`nameOf`); nothing derives a name from the title. `peerName`
  stays in `envelope.ts` for older daemons' slugs.

## What the agent gets (Q2.246)

The text as typed, then `mentionNote`'s second block, `<session-mentions>`, on the
person's prompt route only: each matched session's address, title, harness, folder,
machine, and `send_message to="…"` only where this agent holds the tools.

- **Never waits on the network**: another machine comes from `remoteSettled` (the last
  successful listing; a failure clears it), never `remoteListings`.
- None for a slash command, an envelope or a plugin. `session-mentions` is in
  `IMITATED_TAG`, so `defuse` breaks a forged one.
- **Never in `text`** (the echo, the derived title and `/clear` all compare it): the note
  rides with attachments, and the `prompt` event records `mentions`.
- No status: a queued message is delivered long after it was described.
- Same switches as `list_agents` (Q2.244): nothing where machine or conversation is off
  (`callRefusal`), another machine only while not isolated (`reachesOthers`).

## The `@` menu (Q3.678)

- Rows are `GET /sessions/:id/mentions`, `list_agents`' listing minus this session.
  **`session:write`, not read**: it names other machines. Rows not nickname-shaped are not
  offered.
- Opens on `@` at index 0 or after whitespace, never in a slash draft, so it and the
  command menu exclude each other. `mentionCompletion` keeps what precedes the token and
  replaces the whole token, caret inside or not.
- The cache is keyed by session (no reset in the `[key]` effect). A bare 404 is remembered
  against `health.instanceId`, never for good; with none, the lifetime stands in.
- A bare `@` offering nobody says so (*No other session can be reached from here*, or that
  the listing failed); a typed name matching nobody closes the menu.
- `MentionMenu` is `CommandMenu`'s panel under its own ids; `aria-controls` and
  `aria-activedescendant` follow whichever is open. It is in the typeless-`<button` scan.

## Every `@name` is a link (Q3.682)

Every drawn nickname wears its `@` and leads to its session — in a person's message
(`MentionText`, `prompt.mentions` first), an agent's Markdown (`remarkMentions`, never in
code or a link), a peer message's headline (the sender's ref). `mentionTarget`: the
daemon's resolution, then a nickname on this conversation's machine (`MentionScope`), then
one held by exactly one session anywhere; else plain text.

- **A `<button>`, never an anchor**; the router is imported on the tap (it parses the
  address bar on load, and webcheck imports the transcript with none).
- The store is read through a string key, or every streamed event re-renders every link.
- `hug.ts` measures lines, not text nodes (`lineSpans`).

## New session (Q3.677)

Machine, agent, nickname, folder. The kit's `Field` (refusal on `aria-describedby`),
narrow, after an `@`, prefilled with a name nobody on a visible machine holds, so Start
still works in one press (not Q3.87's optional box). The draft is module state (the screen
unmounts for the builder). A created snapshot without `nickname` means an older daemon,
and the screen says so.

## Not built (Q7.153)

Renaming a nickname, mentions from agents or plugins, a mention chip in the bubble, one
nickname per account, a plugin API rung.
