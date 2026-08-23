# Plugins

A plugin adds something to **one machine**: a screen, a settings pane, an action
on a session's menu, and code that runs when the agents on that machine do
something. It is installed by whoever owns the machine, from a file they chose,
and it runs on that machine as them.

Two files and about twenty lines is a working plugin. `plugins/board/` in this
repository is the reference one, and everything in this document is in it.

## The two halves, and why they arrive together

A plugin is **one artifact**. Its server half runs on the daemon; its screens are
drawn by the web client from a description the server half returns. That is not
an aesthetic choice — the web client ships inside the control plane's image and
is replaced on a weekly deploy, while a daemon changes when its owner runs
`deploy.sh`. A plugin whose two halves shipped separately would have to reason
about that skew. One archive cannot.

**No plugin code runs in the browser.** The page holding your credential executes
nothing a plugin author wrote, which is the one hard security boundary this whole
subsystem has. What a plugin sends is a description; the app draws it with its own
components, so a plugin screen matches the rest of the app and works on a phone
without its author thinking about either.

The cost is stated rather than hidden: a plugin screen is a list, a form, a set
of columns and some text. It is not a canvas. If that is not enough for what you
want to build, this is not the mechanism, and no amount of manifest will make it
one.

## What is in the archive

A `.tar.gz` or a `.zip`, holding these at its top level — or inside a single
folder, which is what you get by compressing a directory:

```
plugin.json     the manifest
server.js       an ES module, plain JavaScript
```

```bash
tar -czf board.tgz -C plugins/board .
pnpm client plugin install board.tgz
```

Installing an id that is already there **updates** it. There is no separate
update verb, because the manifest is what says which of the two this is.

## `plugin.json`

```json
{
  "id": "board",
  "name": "Task board",
  "version": "0.1.0",
  "api": 2,
  "description": "One card per session, moved by what the agent does.",
  "scopes": ["sessions.read", "store"],
  "contributes": {
    "screen": { "title": "Board" },
    "settings": true,
    "actions": [
      { "id": "advance", "title": "Move card on", "on": "session" },
      { "id": "forget", "title": "Forget this session", "on": "session" },
      { "id": "save", "title": "Save", "on": "screen" }
    ],
    "hooks": ["session.created", "turn.ended", "session.ended"]
  }
}
```

That is `plugins/board/plugin.json` verbatim, and it is meant to stay that way: an
author who copies it and then reads `server.js` beside it must not find handlers
for actions the manifest never declared, because the action route answers those
with `action_not_found`. It carries no `net` at all: the board reaches nothing
outside the machine, and a plugin with no `net` scope omits the field rather than
writing an empty list, which is accepted and does nothing.

| Field | |
|---|---|
| `id` | 1–32 characters, lower-case letters, digits and hyphens. It becomes a directory name and a URL segment, so the case rule is containment rather than style: on a case-insensitive filesystem `Board` and `board` are one directory holding two plugins |
| `version` | Three numbers. Reinstalling the same one is how you iterate; installing a different one is an update either way, so rolling *back* is just installing the old version again |
| `api` | The plugin API this is written against. A **range** is negotiated — see below |
| `scopes` | What the plugin may ask the daemon to do. Shown to whoever installs it |
| `net` | Host names `net.fetch` may reach. The `net` scope requires a non-empty one, and naming a host without that scope is refused. An empty list without the scope is accepted and reaches nothing |

Everything is validated once, at install, and a bad field is a refusal naming it.
Nothing is repaired: an omitted optional gets its obvious meaning, and a wrong
value is told rather than guessed at.

### `api` is negotiated, and the daemon's version is not

`api` is checked against a range the daemon supports. Outside it you get one of
two refusals, and they are separate because their remedies are opposite:
`plugin_api_too_old` means republish the plugin, `plugin_api_too_new` means update
the machine.

**`api: 2` added `open`, `refreshMs` and `tone`.** If your plugin needs them,
declare `2` — an older daemon then refuses it with a sentence rather than silently
dropping your navigation. If it does not, stay at `1` and run everywhere.

**Never branch on the daemon's version.** `DAEMON_VERSION` is a label — announced,
recorded, and read by nothing. A plugin that behaves differently for `0.2.0` than
for `0.3.0` puts every daemon in the fleet back in lockstep with a release nobody
coordinates. If you need to know whether something is there, ask for it and read
the refusal.

## `server.js`

Four exports, all optional. A missing one that the manifest promised is a refusal
naming it, rather than an empty screen nobody notices for a week.

```js
export async function screen(ctx) { … }              // contributes.screen
export async function settings(ctx) { … }            // contributes.settings
export async function action(ctx, event) { … }       // contributes.actions
export async function hook(ctx, event) { … }         // contributes.hooks
```

**Plain JavaScript.** The daemon happens to run under `tsx` today, so a
TypeScript `server.js` also loads; that is a measurement rather than a promise,
and a plugin must not depend on this daemon's toolchain.

### A view is a read

`screen` and `settings` are reached by `GET`, which the transport is allowed to
repeat after a failure that said nothing about whether the daemon acted. So a view
must not write. Nothing enforces that — a plugin is arbitrary code — but a view
that writes is a bug a retry will find.

`action` is where writing belongs.

### What `action` gets and returns

```js
export async function action(ctx, event) {
  // event.action  the action id that was pressed
  // event.session a session id, when the press came from a session's menu
  // event.row     a row id, when it came from a row on your own screen
  // event.form    the form's values, when it was a form's submit
  return { kind: "toast", text: "Saved", tone: "default" };
}
```

Return a **toast** to say one sentence, or a **view** to redraw the screen the
press came from — returning `screen(ctx)` is how a row disappears rather than
merely being reported gone. Returning nothing means "say nothing".

An action pressed from a session's menu can only produce a toast: there is no
plugin screen under it to redraw, and opening one would be a plugin choosing where
somebody goes, which no control in this app does.

### What `hook` gets

```js
export async function hook(ctx, event) {
  // event.hook    "session.created" | "turn.ended" | "session.ended"
  //               | "permission.requested" | "permission.resolved"
  // event.session the session it is about
}
```

Hooks are delivered one at a time, in order, and never block the daemon: they are
queued and drained on their own. A plugin that has stopped answering has its queue
bounded and the drops reported — the newest events are the ones kept, because a
board catching up cares about the turn that just ended rather than the one from an
hour ago.

`permission.requested` and `permission.resolved` are a pair. The second carries
`outcome`, `optionId` and `by` — and you want all three: `outcome: "selected"`
means an option was chosen, **not** that permission was granted, and `by` is what
separates a person deciding from the daemon sweeping a cancelled turn.

Hooks are **derived summaries**, not the daemon's own event stream. That is
deliberate: the session event union is a wire three coding agents move, and
coupling a plugin to it would make every change in one of them your breaking
change.

## `ctx` — what a plugin may ask for

Every one of these is refused unless the manifest declared the matching scope,
**including inside a hook**, where the manifest is the only authority there is.

| Scope | |
|---|---|
| `sessions.read` | `ctx.sessions.list()` · `.get(id)` · `.events(id, {since, limit})` · `.changes(id)` · `.diff(id, path)` · `.workspace(id)` |
| `sessions.write` | `ctx.sessions.create({agent, cwd, worktree, branch})` · `.prompt(id, text)` · `.cancel(id)` · `.stop(id)` · `.setMeta(id, {title, pinned})` · `.answerPermission(id, permissionId, optionId)` · `.answerElicitation(id, elicitationId, {content}\|{decline}\|{cancel})` |
| `files.read` | `ctx.files.read(sessionId, path)` — a file inside that session's workspace, up to 64 KiB |
| `store` | `ctx.store.get(key)` · `.set(key, value)` · `.delete(key)` · `.keys(prefix)` · `.entries(prefix, after)` |
| `net` | `ctx.net.fetch(url, init)` — https only, only the hosts in `net` |
| `sessions.read` | `ctx.agents.list()` — which agents this machine has and which are signed in. Ask before `sessions.create` |
| always | `ctx.log(message)` · `ctx.plugin` |

There is no `files.list`, deliberately: `sessions.changes` is git's own list of
what a session touched, already bounded and already containment-checked, and it is
a better answer than a directory walk for everything a plugin has wanted so far.

### The store is what survives an update

`ctx.store` is keyed on your plugin's **id**, never its version. That is the whole
of what makes an update an update: a board keeps its cards across `0.1.0` →
`0.2.0` because no part of the key mentions a version. Uninstalling drops it;
updating never does.

Bounds: 1 MiB per plugin, 64 KiB per value, 1000 keys, and 128 KiB per `entries`
page. Values are JSON.

### Read many keys with `entries`, not with `get` in a loop

```js
let after = "";
const cards = [];
for (;;) {
  const page = await ctx.store.entries("card:", after);
  for (const { key, value } of page.entries) cards.push({ ...value, session: key.slice(5) });
  if (!page.more) break;
  after = page.entries[page.entries.length - 1].key;
}
```

`entries(prefix, after)` answers `{ entries: [{ key, value }], more }`: every pair
under the prefix, ascending by key, that fits one page. **Every `ctx` call is a
round trip to the daemon**, so `keys()` followed by a `get()` each — the loop that
reads most naturally — is two messages per key and one turn of the daemon's event
loop per key, on a screen that asks to be re-read every few seconds. Measured over
the 1000 keys a plugin may hold: 20.9 ms and 2002 messages that way, 0.30 ms and
2 messages this way.

`more` means the page reached the daemon's byte budget, **not** the end of your
data — 1 MiB of store does not fit in one 256 KiB answer, so a store that has
grown is read in pages. Ask again with `after` set to the last key you were
handed, echoed rather than computed: the order is the store's, not your locale's.
A short page always says so, because a truncation nobody is told about is a board
showing the wrong number of cards.

### `net.fetch` goes through the daemon

The daemon makes the request, against the hosts your manifest named, so there is
one place a plugin's outbound traffic can be seen. https only, no redirects
followed (a redirect is a second host chosen by the first), 1 MiB of response, 10
seconds, 30 requests a minute.

```js
const answer = await ctx.net.fetch("https://api.example.com/cards", {
  method: "POST",
  headers: { authorization: `Bearer ${(await ctx.store.get("token")) ?? ""}` },
  body: JSON.stringify({ title }),
});
// { status, headers, body }
```

## Drawing

A view is `{ title, refreshMs, blocks }`, or just an array of blocks. Five block
types:

```js
{ type: "text",    text: "…", tone: "default" | "muted" }
{ type: "notice",  text: "…", tone: "default" | "danger" }
{ type: "list",    rows: [Row], empty: "Nothing here." }
{ type: "columns", columns: [{ title: "Todo", rows: [Row] }] }
{ type: "form",    fields: [Field], submit: "Save", action: "save" }
```

```js
// Row
{ id, title, subtitle, badge,
  tone: "ok" | "warn" | "danger" | null,      // what it MEANS; the host picks the ink
  open: { session: "s_ab12" } | { screen: true } | null,   // where tapping it goes
  actions: [{ id, label, tone: "plain" | "destructive", confirm }] }
// Field
{ key, label, kind: "text" | "password" | "number" | "toggle" | "select",
  value, options: [{ value, label }], placeholder, help }
```

**`tone` is why a plugin cannot send CSS.** You name the meaning, the app picks
the colour — so a row cannot fall below the contrast floor, cannot spend the one
heavy fill the palette has, and cannot be wrong about it on a phone in sunlight.
An unrecognised tone is no tone: you can fail to mark something as wrong, and you
cannot mark something wrong as fine.

**`open` names a destination this app has, never a URL.** A session on this
machine, or your own screen. `{url: …}` is not a shape and lands as a row that
does not go anywhere. Two reasons: a link chosen by a plugin is a phishing
surface on the page that approves shell commands, and "a plugin deciding where
somebody goes" is already refused for session-menu actions. A row's actions still
take precedence over its `open`.

A row action's `id` must be one your manifest declared. `confirm` turns it into a
two-step control, which is what a destructive one should have.

Every field's `value` is a **string**, including a toggle — `"true"` or `"false"`
— so there is one narrowing rather than five.

Anything the client does not recognise degrades rather than breaking: an unknown
block is not drawn, an unknown field kind becomes a text input and still
round-trips. Oversized views are cut with a line saying so rather than refused.

## Keeping a screen current

```js
export async function screen(ctx) {
  return { title: "Board", refreshMs: 5000, blocks: [...] };
}
```

The host re-reads your screen on that interval — **floored at 2 s, capped at 5
min, and only while somebody is looking**. It stops when the sheet closes and
when the tab goes to the background, so a small number does not buy background
work on somebody's phone.

A refresh never blanks the screen and never replaces it with an error: the old
view stays until the new one arrives, and a failed tick is silent. A machine
dropping off LTE for one tick is not news.

**A settings pane is not refreshed**, whatever it asks for. It is a form somebody
is typing into, and re-reading it under them would either discard what they typed
or keep it over a value you have since changed.

## A settings pane is a view

There is no separate settings schema. `settings` returns a view; a form's `action`
names one of your actions; that action writes to `ctx.store`. One vocabulary.

A secret is your own decision to make: return `kind: "password"` and whatever you
want shown for a value that is already set — the empty string is the usual answer.

## Updating one

The whole point of the demo plugin. Add a column and reinstall:

```bash
# plugins/board/plugin.json:  "version": "0.2.0"
# plugins/board/server.js:    add { id: "review", title: "Review" } to COLUMNS
tar -czf board-0.2.0.tgz -C plugins/board .
pnpm client plugin install board-0.2.0.tgz
```

The new column appears and the cards are where they were.

**If the new version will not start, nothing changes.** The archive is refused
with `plugin_start_failed` carrying what your code said, the new files are
removed, and the version that was running starts again. A broken update on a
machine you are not sitting in front of leaves you with the plugin you had. That
holds when you reinstall the version already there — which is how you will spend
most of your time — and when the plugin is switched off, in which case it is
started long enough to prove it runs and then switched back off.

## What a plugin is trusted with

Said plainly, because the alternative is somebody assuming otherwise.

**A plugin runs as you.** It is a child process of the daemon, with your uid, your
`HOME`, your files and your keys — the same trade an agent already makes on the
same machine. The scope list and the stripped environment are **hygiene, not a
fence**: a plugin can `import("node:fs")` and read anything you can.

What they do buy is real, and it is three things. The blast radius is *named*,
shown at install and refused when exceeded, which catches the mistake. A plugin
that hangs or crashes cannot take the daemon's event loop with it — that is what
the child process is for. And the plugin never holds the daemon's token or its
database handle.

What is a genuine boundary: **the browser runs none of it.**

Install plugins you would run in your own terminal. Nothing downloads one for
you, nothing updates one by itself, and no plugin arrives without somebody on that
machine choosing it.

## Updating the fleet, in order

**Daemons first, then the control plane.** The web client is what calls
`GET /plugins`, so the daemon is the side that has to be able to answer — and a
control plane deployed first hands every user a Plugins screen that says *"update
your machine"* until each owner does.

1. Update the daemons, one at a time, whenever their owners get to it. Nothing
   visible changes.
2. Install plugins. `pnpm client plugin install` needs no UI, and the hooks start
   writing immediately — so the first board anybody opens is already populated.
3. Deploy the control plane, which is what carries the web client.

The other order breaks nothing: an old client never asks, and a new client against
an old daemon says the sentence above rather than failing. It just spends the
tolerance for no gain.

## Commands

```bash
pnpm client plugins                     # what is installed, and what each may reach
pnpm client plugin install <archive>    # install or update
pnpm client plugin remove <id>          # uninstall, and drop what it kept
pnpm client plugin enable <id> | disable <id>
pnpm client plugin view <id> [screen|settings]   # what it would draw, as JSON
```

`REEMOAT_PLUGINS=0` switches the whole subsystem off on a machine; the routes then
answer `503` rather than reporting an empty list, because "there are none" and
"this daemon does not do that" are different answers.

## Bounds

| | |
|---|---|
| Archive | 2 MiB on the wire, 8 MiB unpacked, 500 entries. One install at a time per machine |
| Store | 1 MiB per plugin, 64 KiB per value, 1000 keys, 200 characters per key, 128 KiB per `entries` page |
| A view | 24 blocks, 200 rows per list or column, 8 columns, 40 fields, 4 actions per row, 4000 characters of text. Over any of them the view is **cut to fit and says so**, never refused — and cut again if it is still larger than one message |
| Refresh | 2 s floor, 5 min cap, paused while the tab is in the background |
| Answering | 10 s per call, 256 KiB per message (the harder of the two bounds, and what a view is cut to), 8 calls in flight to your plugin, 16 host calls in flight from it |
| Starting | 10 s, then 3 restarts per daemon life with backoff; three timeouts in a row stops it |
| `net.fetch` | https only, 10 s, 1 MiB, 30 requests a minute, no redirects |
| Files | 64 KiB per read |
| Hooks | 256 queued per plugin, drop-oldest, with the drops reported |
