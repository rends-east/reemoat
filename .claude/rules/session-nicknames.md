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

**A session has a title and a nickname, and they answer different questions.** The
title is what the session is about — derived from the first message, renamed by a
person — and it still leads the list and the header. The nickname is its address:
`mira`, what a person types after `@` and what other agents call it. It is drawn
under the title, `@mira` at the head of the row's subline and of the header's
subtitle (`nicknameLine`). The owner asked for nicknames *instead of* titles and
corrected it the same day; Q3.677 is that correction, and it is why `sessionLabel`
and Rename did not change.

## What a nickname is (Q2.245)

- **One shape, written twice.** `src/nickname.ts` is the daemon's and
  `packages/web/src/nickname.ts` its hand mirror; `webcheck` imports the first and
  compares `NICKNAMES` and every verdict. Lowercase latin, digits and single
  hyphens, starting with a letter, 2–32 characters. ⚠ **No underscore, ever**:
  `PeerHub.resolve` reads an underscored word as a session id. The shape also passes
  every daemon's `isPeerName`, so a listing row survives on a machine running an
  older build.
- **One per machine, over every row the registry holds, ended ones included.**
  ⚠ **The check is a reservation, not a lookup**: `reserveNickname` runs
  synchronously at the top of `create`, before the capacity check, the create token
  and `createWorkspace`, and `create` releases it in a `finally`. A lookup just
  before `sessions.set` would let the loser of two concurrent creates make its
  worktree and branch first. No UNIQUE index: `put` swallows errors.
- **Always present.** A create that names none takes `pickNickname`. `restore()`
  gives one to every row that predates the column, oldest first, so the older of two
  duplicates keeps its name — and it stays synchronous, like the rest of `restore`.
  A nickname is never cleared; `/meta` refuses `null`.
- **It is the peer name.** `nameOf` answers it, and nothing derives a name from the
  title any more. `peerName` stays in `envelope.ts` because an older daemon on
  another machine still sends its slugs.

## What the agent gets (Q2.246)

**The text as typed, then the daemon's note.** `mentionNote` runs on the person's
prompt route and nowhere else, and returns a second text block, `<session-mentions>`,
naming each matched session: address, title, harness, folder, machine, and
`send_message to="…"` only where this session's agent holds the tools.

- ⚠ **It never waits on the network.** Another machine is read from
  `remoteSettled`, the last *successful* listing, which a failed one clears. Awaiting
  `remoteListings` there would put up to three seconds on every message a person
  sends, for a word that may be `@Override`.
- **Not in a slash command, not in an envelope, not from a plugin.** A text starting
  with `/` gets none. `session-mentions` is in `IMITATED_TAG`, so `defuse` breaks one
  forged inside a peer's body.
- **Never in `text`.** The echo is matched on it, a title is derived from it and
  `/clear` is compared with it. The note rides where attachments ride, and the
  `prompt` event records the names it resolved as `mentions`.
- **No status**: a queued message is delivered long after it was described.
- **It answers to the switches `list_agents` answers to** (Q2.244): nothing is named
  where the machine or the conversation is off (`callRefusal`), and another machine
  only while this one is not isolated (`reachesOthers`).

## The `@` menu (Q3.678)

- **Its rows are the daemon's**, `GET /sessions/:id/mentions` — the listing
  `list_agents` gives this session's agent, without itself. ⚠ **`session:write`, not
  read**: it names the owner's other machines. A row whose name is not
  nickname-shaped is not offered, since the daemon would not resolve it.
- **It opens on an `@` at index 0 or after whitespace, never in a slash draft**, so
  it and the command menu are exclusive by construction. `mentionCompletion` keeps
  what is before the token — the command menu's `completion` owns index 0 and drops
  it — and replaces the whole token, caret inside or not.
- **The cache is keyed by session**, so a conversation switch owes it no reset in
  the `[key]` effect. ⚠ **A bare 404 is remembered against the daemon's instance id**
  (`health.instanceId`), never for good: remembered for good, a session that asked
  before its daemon was updated offered nothing until a reload, which is how this
  first shipped. With no instance id, the lifetime stands in for one.
- **A bare `@` that offers nobody says so** — *No other session can be reached from
  here*, or that the listing failed. A typed name that matches nobody closes the
  menu, as the command menu's does.
- `MentionMenu` is `CommandMenu`'s panel under its own ids, and the message box's
  `aria-controls` and `aria-activedescendant` follow whichever is open. It is in
  the typeless-`<button` scan.

## Every `@name` is a link (Q3.682)

Every nickname the app draws wears its `@`, and every `@name` leads to its session:
in a person's message (`MentionText`, following `prompt.mentions` first), in an
agent's Markdown (`remarkMentions`, never inside code or a link), and in a peer
message's headline, which follows the sender's own ref. `mentionTarget` decides: the
daemon's resolution, then a nickname on this conversation's machine (`MentionScope`),
then one held by exactly one session anywhere; otherwise plain text.

- ⚠ **A `<button>`, never an anchor**, and **the router is imported on the tap**: it
  parses the address bar as it loads, and webcheck imports the transcript with none.
- ⚠ **The store is read through a string key**, or every streamed event re-renders
  every link in the conversation.
- ⚠ **`hug.ts` measures lines, not text nodes** (`lineSpans`): a link cuts a line in
  three, and the widest fragment is not the line.

## New session (Q3.677)

Four things now: machine, agent, nickname, folder. The field is the kit's `Field`,
its refusal bound by `aria-describedby`, narrow, after an `@`
mark, and arrives filled in, from
names nobody on any visible machine holds, so Start still works in one press and
this is not Q3.87's optional box back. The draft is module state, since the screen
unmounts for the builder. A created snapshot with no `nickname` is an older daemon,
and the screen says so rather than drawing a name it did not keep.

## Not built (Q7.153)

A control that changes a nickname, mentions from agents or plugins, a chip for a
mention in the bubble, one nickname per account, a plugin API rung.
