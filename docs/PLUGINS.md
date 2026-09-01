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
update verb, because the manifest is what says which of the two this is. An update
keeps everything the plugin stored, and **inherits the switch**: a plugin somebody
had switched off is still switched off afterwards, because re-enabling it on their
behalf is not this daemon's decision to make.

## Being installed from the market

Where the server offers a plugin catalogue, the same archive can be installed
without anybody downloading it: the app sends the machine a repository and a
commit, and the daemon fetches the tarball itself.

Two things follow for you as an author.

**The pin is a commit, and only a full 40-character one.** A tag is refused —
`git tag -f` moves a tag, and what is being installed runs on somebody's machine as
them, with no sandbox. So an unmodified GitHub tarball of a commit is what gets
unpacked, `<repo>-<sha>/` wrapper and all, which is exactly the "one top-level
folder" shape the manifest root rule already accepts.

**Your `plugin.json` is read twice, and it has to say the same thing both times.**
Before anything is sent, the app reads that file at the pinned commit and shows a
person what your plugin asks for. The machine then parses the manifest out of the
archive and compares three fields against what was shown — `scopes`, `net` and
`contributes.hooks` — and refuses the install outright if the archive asks for more.
In practice this only bites if the file in the repository and the file in the
archive differ at the same commit, which cannot happen; it exists so that nobody has
to trust that it cannot.

Nothing about writing a plugin changes. There is no manifest field for this, no
registration step, and no way for a plugin to install itself or to update itself.

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

> ⚠ **All three of `session`, `row` and `form` are independently `null`, and an
> absent one is not a default.** Declaring an action puts a verb on this daemon's
> HTTP surface — `POST /plugins/:pluginId/actions/:actionId` — and the daemon
> passes whichever context the caller sent, which may be none of them. A body of
> `{}` reaches your handler with `event.form === null`.
>
> This bites hardest on a settings form, because the shape of an absent toggle and
> the shape of a toggle somebody switched **off** are the same shape once you stop
> looking. Measured on a real daemon: a plugin whose `save` read its checkbox as
> `event.form?.on === "true"` had that setting silently switched back **on** by an
> empty POST, undoing what the person had just turned off. A string field read
> through `typeof … === "string"` was unaffected; the toggle was not.
>
> So branch on the context you need before you write anything: `if (event.form ===
> null) return;` is the whole of it. Treating a missing context as "use the
> defaults" writes your defaults over somebody's configuration.

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
| `model` | `ctx.model.complete({agent, prompt, model})` · `ctx.model.list({agent})` — one question to an agent, and which models it offers |
| always | `ctx.log(message)` · `ctx.plugin` |

There is no `files.list`, deliberately: `sessions.changes` is git's own list of
what a session touched, already bounded and already containment-checked, and it is
a better answer than a directory walk for everything a plugin has wanted so far.

### A key nobody set reads as `null`

`ctx.store.get(key)` answers **`null`** for a key you have never written — never
`undefined`. Check for it as `null`, or with `??`, and not with `!== undefined`.

This is the one place the type cannot help you: the value is `unknown`, because it
is whatever you stored. A plugin that wrote

```js
const done = await ctx.store.get(`t:${session.id}`);
if (done !== undefined) return;              // wrong: null !== undefined
```

took the "already done" branch for **every** session, for weeks. Nothing said so:
a hook that returns early writes no key, logs nothing and leaves no history, so it
is indistinguishable from a hook that was never called at all. The plugin looked
dead while every part of the daemon was working.

A stored `null` and a key nobody set are the same answer. If you need to tell them
apart, store a wrapper — `{value: null}` — rather than the bare value.

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
followed (a redirect is a second host chosen by the first), 64 KiB of response,
10 seconds, 30 requests a minute.

**64 KiB, and it is the same fact `entries` is paged for**: what comes back is
handed to you inside one 256 KiB message, re-escaped as a JSON string with the
whole `headers` object beside it, and a body that is all `"` doubles on the way —
so 1 MiB, which this used to say, is four times what could ever be delivered. A
response past the bound is refused with `response_too_large` rather than
truncated, and it is refused *while it is still arriving*, so ask your service
for a page rather than for everything.

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

**A settings pane also draws less than your screen does** — three block types and
three field kinds. The table is one section down, and it is the commonest surprise
in this API.

## Asking an agent one question

`model` is the one scope that spends the operator's **money** rather than the
machine's access, and the sentence somebody reads before granting it says so. Use
it sparingly and never on a timer.

```js
const { text } = await ctx.model.complete({
  agent: "claude",
  prompt: "Name this conversation in under six words.",
  model: await ctx.store.get("model"),   // optional; see below
});
```

**One question, one answer, nothing left behind.** The session it runs in is
unaddressable: it is not in anybody's list, it has no transcript, and it is
disposed when the answer arrives. Bounds: 8 KiB of prompt, 16 KiB back, 120 s,
6 requests a minute per plugin, and 2 at a time for the whole machine.

> ⚠ **Do not `await` this inside a hook, a view or an action.** Those are
> *invocations*, and an invocation has **10 seconds** to answer against this
> call's **120**. So awaiting it means your invocation is timed out long before
> the model replies — and three consecutive timeouts stop your plugin, with
> "stopped answering after 3 requests" on its row. The two numbers are printed
> together here because they are eleven pages apart in the bounds table, which is
> how this was easy to get wrong.
>
> Start it and let the hook return. The turn is meant to outlive the invocation
> that began it, and when your plugin is stopped, disabled, updated or removed the
> daemon withdraws the call for you: an ask still running is ended and the agent it
> started is disposed, and the code you get is `model_cancelled` rather than
> `model_timeout` so the two are never confused for one another.
>
> ```js
> // In a hook: start it, write the answer where your screen will find it, return.
> void ctx.model
>   .complete({ agent: "claude", prompt: "Name this in under six words." })
>   .then(({ text }) => ctx.store.set(`title:${event.session.id}`, text))
>   .catch((error) => ctx.log(`naming failed: ${error.message}`));
> ```
>
> That shape needs `"scopes": ["model", "store"]` — `ctx.store.set` is its own
> scope, and `ctx.log` needs none.

**Every refusal carries a code**, because this is fire-and-forget — no invocation
is waiting to fail and there is no screen to open on it. `model_agent_unknown`,
`model_agent_unavailable`, `model_agent_signed_out`, `model_busy`,
`model_rate_limited`, `model_timeout`, `model_cancelled`, `model_too_large`,
`model_unknown`, `model_not_selectable`, `model_unavailable`,
`model_prompt_too_large`, `model_prompt_empty`, `model_failed`. Show them; you are
the only place they can appear.

### Choosing a model

```js
const { models } = await ctx.model.list({ agent: "claude" });
// [{ id: "opus", name: "Opus 5", description: "…", group: null }, …]
```

**This daemon has no list of models of its own and could not have one.** Which
models exist is a fact about the agent's CLI on that disk, published over ACP, and
it changes when somebody updates it. So `list` **starts the agent** to find out —
no prompt is sent and no quota is spent, but it is a subprocess and a handshake.
It is cached for ten minutes and it costs one of your six requests a minute. Call
it when you draw a picker, not on every hook.

An agent that offers no choice of model answers with an **empty list**, and that
is an answer rather than an error — kimi is one. Draw "this agent does not offer
one" rather than an error where a dropdown was.

⚠ **A model you did not choose has three spellings and they all mean the same
thing.** Left out, `null`, and `""` — a field omitted, a `ctx.store.get` for a key
nobody has written, and a form submitting an untouched control — all mean *use the
agent's own default*. None of them is an error, and there is no fourth spelling to
learn. (Whitespace-only is the same as empty.)

⚠ **A model is validated against the agent when it is used, not when you listed
it.** Your cached list may be up to ten minutes old and a CLI update can retire a
model in between, so `model_unknown` is a real outcome for a value that was valid
when you drew the dropdown. Its message names what the agent offers now.

⚠ **The choice does not survive anything.** It applies to the one throwaway
session this call makes and nothing else — it is not a preference stored on the
machine, and a session a person starts in the app is unaffected.

## A settings pane is a view, and a narrower one than your screen

There is no separate settings schema. `settings` returns a view; a form's `action`
names one of your actions; that action writes to `ctx.store`. One vocabulary.

**But not all of it.** A settings pane is a form plus the words around it, and the
host draws exactly this much of what you return:

| | on your `screen` | on your `settings` |
|---|---|---|
| blocks | `text` `notice` `list` `columns` `form` | `text` `notice` `form` |
| field `kind` | `text` `password` `number` `toggle` `select` | `text` `toggle` `select` |

A **setting is one of three controls**: a box you type in, a switch, a dropdown.
`text` and `notice` stay because neither is a setting — they are the sentence
above a control and the warning beside it, and a form with no way to say anything
about itself is a worse pane rather than a stricter one.

**If you have no `screen`, `notice` is your whole diagnostic channel — use it.** A
hook's failure has nobody waiting on it: nothing asked, so nothing is owed an
error. `notice` with `tone: "danger"` on your settings pane is where a person finds
out, and the host keeps the tone. Do not put that record in a `list`; see below.

**A `list` or a `columns` on a settings pane is dropped, and the pane says so** —
naming the type, and naming the three it does draw. If you have rows, you have a
**screen**: that is what `contributes.screen` is for, and it is one tap from the
same page.

One consequence to plan around rather than discover: `open` lives on a row, and
rows live only in `list` and `columns`, so **a settings pane can link to nothing**.
A name that used to take somebody to a session becomes prose. If those links are
the point, that is a screen.

**`password` and `number` are drawn as a plain text box on a settings pane, and
that is reported as a substitution.** Neither was a fourth kind of setting:

- `value` is a string on the wire whatever the `kind`, so `number` never
  round-tripped as a number — you parsed a string either way, and all the kind
  ever bought was a numeric keyboard.
- `password` masked a value the daemon keeps in `plugin_data`, which is a column
  in a plaintext SQLite file that everything running as your uid can read,
  including the plugin next to yours. The mask was an assurance this system does
  not provide, on the one screen where a false one costs most.

So **do not put a secret in a settings pane and expect it to be hidden.** Nothing
here can hide it. If you need a credential, the honest shapes are the machine's
own environment — which you read yourself, as the process you are — or a value the
person pastes knowing it is stored in the clear.

Both narrowings are applied twice, on purpose: the daemon clamps the pane it
answers a read with, which is what produces the notice you see, and the browser
clamps what it draws — including the view an **action** answers with, which the
daemon cannot classify (an action id says which action, never which pane pressed
it).

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

## Adding an agent, or a provider

A plugin can put a **harness** — an ACP program — and an **inference provider**
on a machine, and both then behave as though this product had shipped them. There
is no code to write for either: they are two blocks in `plugin.json`, your
`server.js` is never asked about them, and nothing is fetched at runtime.

```jsonc
{
  "api": 5,
  "scopes": ["harness", "system"],
  "contributes": {
    "harnesses": [{
      "id": "gemini",                     // the machine calls it "<your-plugin-id>:gemini"
      "name": "Gemini",                   // what a tile says. 32 characters
      "command": "gemini",                // a program on PATH. Not a path, not an argument
      "args": ["acp"],
      "envNames": ["GEMINI_API_KEY"],     // variables a pasted key is written to
      "routedModelEnv": ["GEMINI_MODEL"], // variables it reads a routed model id from
      "authHint": "…"                     // what to say when it refuses a session
    }],
    "systems": [{
      "id": "groq",
      "name": "Groq",
      "apiType": "anthropic",             // or "openai" — the wire shape, nothing else
      "baseUrl": "https://api.groq.com/anthropic",
      "authHeader": { "name": "authorization", "prefix": "Bearer " },
      "models": [{ "id": "llama-4", "name": "Llama 4" }]
    }]
  }
}
```

Install that and the harness is in the agent builder's harness row and under
Sign-ins with a paste box; the provider is a heading in the model picker and a key
box in the same list, beside the built-in ones. Somebody assembles the two into a named agent exactly as they would
Claude Code on OpenRouter, and **that** is what gets a tile on New session.

⚠ **`envNames` is where your harness's key is pasted, and it gets a row of its own
under Sign-ins — but only if no provider already speaks for it.** That list is
per machine, and it holds two kinds of row: a provider you have an account with,
and a harness that reads a key of nobody else's. Every harness this product ships
is named by a provider's `loginVia` — Anthropic signs in through Claude Code — so
those get their box on the provider's card and never a second row. Yours gets one
unless you also contribute a provider naming it.

If a *provider* of yours is the thing people sign in to, give it `loginVia` and
put the key there instead; the harness then has no row and no second answer to
"signed in?". If your harness needs no key at all, leave `envNames` empty and let
`authHint` send people to a terminal — which is what a harness signed in by
running its own program once wants.

**Both need `api: 5`, and the daemon refuses the block below it rather than
ignoring it.** That is deliberate and unlike every other field here: a plugin
whose whole reason to exist is a harness has no useful degraded form, so an older
daemon tells its owner to update the machine instead of installing something inert.

### The traps

⚠ **Your plugin adds a harness. It does not add an *agent*.** There is no way to
say "tapping this on New session is a whole decision", and there was one for a
release — `standalone`, now removed. The claim is the one thing in this block
nothing on the machine can check, and getting it wrong the permissive way means
somebody starts a session, on your suggestion, on whatever model your CLI picks by
default. A manifest still carrying the key installs unchanged; it is simply not
read. Your harness is offered everywhere a harness is named — it just has to be
paired with a model first, which is two taps, and is exactly opencode's position.

⚠ **`command` is a program name on `PATH`, and your plugin does not install it.**
No slashes, no absolute paths, and not the name of an agent this product already
ships. A machine that does not have the program says so on the row.

⚠ **A provider may only ever name a harness *you* contribute.** `nativeHarness`,
`loginVia`, `nativeModelPrefix` and `keyEnv` all take a local harness id from the
same manifest. You cannot point a provider at Claude Code — a screen that said
"Sign in to Claude Code" under a heading you chose would be a lie somebody acts on.

⚠ **`envNames` is a list of boxes somebody will paste a secret into, so it may not
name one another agent reads.** `ANTHROPIC_API_KEY`, `CODEX_API_KEY` and the rest
are refused, as is anything the daemon strips from an agent's environment on
purpose.

⚠ **`baseUrl` is `https`, or `http` to this machine or this network.** Ollama at
`http://127.0.0.1:11434`, vLLM at `http://10.0.0.5:8000` and an
`https://…` endpoint anywhere are all fine; `http` to a public host is not, and
neither is a metadata address under either scheme. Where it *is* `http`, the
consent screen says the key travels in the clear.

⚠ **There is no sign-in flow, and there will not be one in this version.** A
contributed harness is opencode's shape: no wizard, no sign-out, no status probe —
a paste box and nothing else. That box is on the harness's **own** row under
Sign-ins, unless a provider of yours names it in `loginVia`, in which case it is on
that provider's card and the harness has no row — one credential, one place, one
answer. Everything a wizard needs is a *measurement about a
CLI* that nobody but its author can take, and a status pattern from a manifest
would be somebody else's regular expression running on the daemon's event loop.

⚠ **`routedModelEnv` is what lets your harness run somebody *else's* provider's
models.** Name the variables your CLI reads a model id from; each is set to the id
and nothing else — there is no template language. Leave it empty and the daemon
refuses that pairing rather than starting a session that quietly runs your CLI's
default model.

### Trying it

`rends-east/reemoat-plugin-byo` is a working one — Gemini CLI as the agent,
DeepSeek as the provider — and it holds **no scope that gates a method**, so its
consent card shows the two things it adds and nothing else. Install it from the
market, or straight from the commit:

```bash
pnpm client plugin install byo.tgz     # after `tar -czf byo.tgz -C <its checkout> .`
```

Both of its entries are measured rather than copied from documentation:
`gemini --acp` is what Gemini CLI 0.53.0's own `--help` names
(`--experimental-acp` is the same flag, deprecated), it answers ACP `initialize`,
and it declares no way to be pointed at another provider — which is why its
manifest names no `routedModelEnv`. `api.deepseek.com/anthropic` answers `401` in
Anthropic's envelope and reads a key from either header convention.

Nothing has to be installed for it to be worth looking at. With neither `gemini` on
`PATH` nor a DeepSeek key, the agent's row says *not installed* and the provider's
models are greyed with *"No DeepSeek key on this machine."* — which is the whole
disclosure surface working. `npm i -g @google/gemini-cli` and a key make it run.

### What it costs the machine

Each contributed harness is a **process** every time the agent builder is opened:
that screen asks every harness what it offers, two at a time. Eight per machine is
the ceiling and it is refused at install rather than trimmed afterwards. Providers
cost nothing — they are a table row — and the ceiling there is about a picker
somebody has to scroll.

### What is not built

- **A model catalogue your provider fetches.** `models` is written down. The
  browser fetches exactly one catalogue in this whole product and its address is
  compiled into the page's own content policy at deploy time, so a plugin's cannot
  be added. A provider whose native harness publishes its models needs no list.
- **An icon.** A contributed harness is drawn as a letter in the app's own weight.
- **A binary inside the archive.** `PATH` only.

## What a plugin is trusted with

Said plainly, because the alternative is somebody assuming otherwise.

**A plugin runs as you.** It is a child process of the daemon, with your uid, your
`HOME`, your files and your keys — the same trade an agent already makes on the
same machine. The scope list and the stripped environment are **hygiene, not a
fence**: a plugin can `import("node:fs")` and read anything you can.

**A harness you contribute adds no authority you did not already have**, which is
worth saying because it looks like it does. A plugin can already
`import("node:child_process")` and spawn whatever it likes; what declaring a
harness buys is that the program is *named*, shown before anything is installed,
and switched off with the plugin. A **provider** is the one that adds something
real — a host the operator's own pasted key is sent to — and that is why its
address is on the consent screen in full rather than as an origin.

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
| `net.fetch` | https only, 10 s, **64 KiB** of response, 30 requests a minute, no redirects. A quarter of one message, because the body is re-escaped into it beside the whole `headers` object |
| Files | 64 KiB per read |
| Hooks | 256 queued per plugin, drop-oldest, with the drops reported |
