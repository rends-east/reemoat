---
paths:
  - packages/web/src/plugins.ts
  - packages/web/src/catalogue.ts
  - packages/web/src/market.ts
  - packages/web/src/nav.ts
  - packages/web/src/install.ts
  - packages/web/src/pane.ts
  - packages/web/src/pluginArchive.ts
  - packages/web/src/ui/PluginView.tsx
  - packages/web/src/ui/PluginScreen.tsx
  - packages/web/src/ui/PluginConsent.tsx
  - packages/web/src/ui/plugins/*
  - packages/web/src/ui/settings/PluginsPanel.tsx
  - packages/web/src/ui/settings/MachinePluginsSection.tsx
---

**The browser's half of the plugin story: what it draws, what it refuses to draw,
and where a plugin is installed from.** `plugins.md` is the other half — the
daemon: what a plugin may *do*, what bounds it, and who is told about what. The
split is by which process the rule constrains, and it happened because the two had
grown into one file that hit its own size ceiling twice in a day, which is the
signal the file's own budget exists to give.

**The one boundary that matters and is stated in both files: the browser executes
nothing a plugin author wrote.** A plugin sends a *description* and this app draws
it, so the origin holding `reemoat.credential` runs none of it. Everything below is
downstream of that.

## Invariants

- **Every narrowing in `packages/web/src/plugins.ts` fails open.** Rule 2 of
  `compatibility.md` on a third schedule: an unknown block is dropped, an unknown
  field kind becomes a text input and still round-trips, nothing throws. The
  failure this exists to prevent is `endedWithDaemon`, which answered *no* for a
  reason it had never heard of and took the composer off screen for a live
  session. Q3.448.
- **A clamp is said out loud, and a *substitution* is a clamp.** `ClampedView`
  carries two facts, because they send an author to two places: `clamped` is "too
  large", `substituted` is "not a shape this daemon knows" — an unrecognised
  `kind`, a field with no `key`, a form with no `action`. ⚠ **Fail-open protected
  the client and guaranteed the author would never find out**: a form whose fields
  lost their `key` renders perfectly, submits nothing and looks like it works.
  Absence of `kind` is a *default*, or every good plugin draws the notice and it
  stops meaning anything.
- **Nothing is drawn before the plugin has answered.** No skeleton board, no
  optimistic row, no locally-applied action: a plugin's view is its assertion about
  its own state and this client has no second copy to guess from. Q3.449.
- **The launcher is in the account menu, never in the list.** The rail is the
  sessions; a menu row takes part in no ordering, filter or count. It was a
  bordered button per plugin under New session, which grew the footer without
  bound.
- **Plugin rows in the session menu sit in their own band above Resume and Stop**,
  each naming its plugin: two may both offer "Move on". The old rule was *never
  above Stop* — and it produced the opposite of what it protected, because Stop
  stopped being the last row the moment anything was installed and sat in the
  middle of somebody else's words. Above the separator, **Stop is last at every
  install**, which is the stronger form of the same property. The title and the
  plugin's name are two elements so the name gives way first: one string wrapped a
  208px panel to two lines and moved Stop by however long an author's title was.
  Q3.461.
- **A plugin's settings live on the plugin's page, and the settings sheet links
  out.** Q3.447 put them inside a machine — the code is on one host's disk and the
  data in one daemon's database, so a fleet-wide screen would open with a dropdown
  asking which. That argument is **answered rather than reversed**: the plugin's
  page already knows which machines it is on, so it asks over *those*, and does not
  ask where there is one. What sat inside the machine was six taps behind a kebab
  and nobody found it. What stays per-machine is what cannot be anywhere else —
  what is installed, the switch, a failure, a file handed to this daemon — and
  every row there is a **link to the plugin's page**, carrying no scope prose: that
  wall was identical on every machine and its own permissions are one tap away.
  There is no `…/plugins/:pluginId` leaf any more; the address still parses, to the
  machine. Its **screen** is at `/p/:machineId/:pluginId`: a board is opened
  several times a day, and four taps into a settings sheet is not where that goes.
  Q3.447, Q3.459.
- **And they are a screen of their own, one push deep, ◀ back to the plugin.** The
  two answer questions asked at different rates: the entry page is *what this plugin
  is* and is read once, its settings are what somebody comes back for — as a
  section, the thing read a hundred times sat under a permissions fold, above an
  install control, on a page that also carries a version history. The head names the
  screen with the word *settings* where the entry head puts a version — a version
  there would be the wrong fact, since the machines may be on different ones. Q3.462.
- **The way in is the bulk bar's Settings, and the scope rides the URL.** ⚠ **The
  gear is gone.** It was the only route in and it asked no question about *which*
  machines: the screen it opened picked one from a dropdown over
  `installs.filter(contributes.settings)` — a set that is not the set the plugin is
  on — and where that came to one it drew no control at all, so the commonest state
  named no machine anywhere. `/plugins/p/:id/settings/:m1/:m2…`, one segment per
  machine and **never a comma-joined list**: `encodeURIComponent` does not escape a
  comma, so `a,b` and one id holding a comma are the same string, and the failure is
  silent and writes to the wrong hosts. **Empty is the entry page and never "all
  machines"** — writing a form into a host nobody selected is what the shape exists
  to prevent, and a wildcard is how it would arrive. The parser dedupes and drops
  empty segments (the fan-out is over this list) and does **not** sort, since the
  builder joins in the order given. The pane then **states** the scope rather than
  asking for it, always and at every count, on a `sticky` line — a long form scrolls
  it off and the question is asked while typing. Q7.108.
- **Settings are enabled only where *every* selected machine can take them, and the
  asymmetry with the other three is the decision.** Install, Update and Remove are
  fan-outs: a machine the act cannot reach falls out and says so on its own row.
  Settings is a **navigation** — one screen, nothing to skip — so a selection of
  seven opening a screen about a subset is the "selected and never heard about
  again" failure in different clothes. ⚠ **`settingsBlockFor` is not
  `skipReasonFor`**: installing is `machine:admin`, reading a pane is `session:read`,
  so a grant that may configure may not install. And **`not_installed` sits below
  `no_scope` and `unreachable`**, because `fetchPlugins` swallows every failure into
  an empty list — "that machine does not have this plugin" about an unread host is a
  claim this client cannot make.
- **One form is written to several machines only where they agree about its shape.**
  `pane.ts`, its own module because everything in `plugins.ts` fails *open* and this
  refuses to draw. Same shape and same values → seed it; same shape, different values
  → **blank, with a red line naming the keys that differed**, because a blanked
  toggle is *off* rather than empty and a checkbox has no third state; different
  shape → **draw no form at all** and group the machines, each group a link to its
  own scope, since submitting one machine's keys to another writes fields it does
  not have and omits ones it does, silently both ways. Values are compared **after
  `seedForm` normalisation**, or an identical fleet reports as mixed. The signature
  is the action id and the sorted `(key, kind)` pairs — labels, order and `options`
  excluded, the last a named hole rather than a covered one. Every machine handed in
  is a target or is named; nothing a machine *said* is dropped, and identical blocks
  collapse so a danger notice on one host is the only attributed line on screen.
- **A field's `help` sits outside its `<label>`.** A `<label>` activates its first
  labelable descendant from anywhere inside it, and both a `Dropdown` trigger and an
  `<input>` are labelable — so with the help paragraph inside, every word of a
  three-line explanation opened the picker. Reported as the field being "clickable
  much lower than it actually is", which is what it was.
- **The plugin's name is drawn at every width, and only the chevron is withdrawn.**
  `marketUpWithinNav` gates the ◀ at `sm`+ because the rail already draws that row —
  and it rode the whole head row for one release, which took the identity off the
  desktop entirely: the sheet says "Plugins", the rail says "Market", and the pane
  opened on a description with nothing naming what it described. The rail makes the
  way *back* redundant; it says nothing about *which plugin*.
- **A plugin's `select` is `Dropdown`, never a native `<select>`.** One shipped
  wearing `FIELD`, and a native select ignores nearly all of it without
  `appearance: none` — so a settings pane had a system-drawn outline among
  `edge-strong` boxes and opened a menu in the OS's colours, in a monochrome app.
  It read as a stylesheet that had failed to load. `Dropdown` also draws a value
  **outside** the offered options as itself: a native select shows the first option
  instead, which is fail-open in the one direction that lies. `webcheck` asserts
  the *absence* of the element, comments stripped. Q3.463.
- **A settings pane is a narrower view than a screen** — `text`/`notice`/`form`,
  and a field is a box, a switch or a dropdown. The narrowing is applied on **both**
  sides and the browser's half is not redundant: the daemon clamps the view it
  answers a *read* with, which is what produces the author's notice, but an
  **action's** answer reaches it as an action id that says which action and never
  which pane pressed it. The component drawing the pane is the only thing that
  knows. `password` becoming a visible box is the substitution that looks like a
  regression and is not — `plugin_data` is a plaintext column, so the mask was an
  assurance nothing here keeps. ⚠ **`notice` is load-bearing, not decoration**: a
  plugin with no screen has no other channel for a failure nobody is waiting on —
  a hook's refusal owes no error and has no session left to warn through — so the
  **tone** is asserted on both sides, a danger drawn in ordinary ink being a
  diagnostic nobody reads. And `open` lives on a row, so a settings pane links to
  nothing: names that were links become prose, which is what having a screen is
  for. Q3.460.
- **The market is a third pop-up, `/plugins`, off the profile menu.** It owns the
  questions that span machines — **where is this plugin**, and **how is it set up**
  — and its answer to the first is a list of checkboxes rather than the machine
  dropdown Q3.447 refuses. Acquiring a plugin is not configuring one, so it sits at
  Settings' own rank rather than four taps inside it. Q3.457, Q3.459.
- **"All machines" is a snapshot, never a standing policy** (Q7.42), and it needs
  no sentence saying so: ticking it fills the list below with ticked boxes, so the
  snapshot is on screen before anything is sent.
- **The rows are a table and the boxes are a selection, and one press acts.** The
  draft could express *moving* a plugin in a single press and could express nothing
  else: no per-row install, no way to find a host by name, and — a fleet being
  unbounded — a collapsed disclosure, so the list somebody came to read and the
  failures written into it were behind the same fold. A fixed-height scroller now,
  with a search box and a filter above it and a bar of four below. ⚠ **Only a
  removal is confirmed**, on the row and in the bar, both ending with Cancel: an
  install is undone by pressing the other icon and a removal takes `plugin_data`
  with it. ⚠ **`rowActs` and `bulkEnabled` are pure and swept**, `draftAct`'s own
  reason — and the bar's counts are derived from `rowActs`, so **the bar cannot
  offer an act the rows do not**. All four `skipReasonFor` states offer nothing, and
  so does a row with a request out, which is also what stops a second bulk press
  double-sending. ⚠ **A hidden row is still selected** — narrowing the filter does
  not unselect — and `selectionLine` says so, or one press reaches machines that are
  not on screen. ⚠ **Row icons are `size="lg"` and never `sm`**: an `sm` is 24px of
  ink reaching 44 through `after:-inset-2.5`, so two adjacent ones overlap by 18px
  and the later element wins the hit test — which on this row is the destructive
  one. ⚠ **The row is a `<div>` with a `<label htmlFor>`**, never a `<label>` around
  it, which may hold no `<button>`. ⚠ **Epochs are per machine**: two rows acting a
  second apart are two acts, and an act-wide counter discards the first's answer for
  a machine the second never touched. ⚠ **The scroller carries no
  `overscroll-contain`** — Chrome ends the chain at a box that has it and nothing to
  scroll — and the box around it is a **definite height, 3.5 rows at every fleet
  size**: under a `max-h` it was the size of its contents, so one machine and a
  no-results sentence were different heights and the bar below moved every time
  somebody typed a letter. The half row is the only thing that says the list
  scrolls. ⚠ **The search, the select-all and the filter are inside that box**, above
  the scroller and `shrink-0`: they are about the rows, and drawn outside the border
  they read as a separate control that happens to sit nearby. ⚠ **A row draws no removal
  at all** — `drawnActs` narrows what `rowActs` reports, and the two are separate
  because the *bar* reads the wider answer to decide whether its own Remove may
  move. A bin on the row put an unrecoverable act 44px from a checkbox, and the
  question guarding it had to replace the row to fit. So there is one question on
  this screen and it is the bar's, and everything a row draws is undone by pressing
  something else on the same row. ⚠ **The one line that changes is *inside*
  the table**, which has a definite height — so nothing it holds can move the bar.
  Reserving space for it below was tried and was not enough: `text-2xs` has an 18px
  line box against a 16px reserve, so the strip still stepped 2px on every tick, and
  reserving the *right* number fixes one instance and leaves the next caller to find
  it again. The blocker wins over the count, since the count is visible in the ticked
  boxes while *why a control will not move* is visible nowhere else. An install never switches a plugin on and an update **inherits** the
  switch, which `installedSubline` now says on the row itself: it lived in
  `outcomeText`, which this screen never rendered. Q3.458.
- **Market icons are `<img src>`, never markup.** An SVG loaded as an image runs no
  script; the same bytes in the DOM do. `icon: null` is *common*, so the fallback is
  the ordinary case.
- **`catalogue.ts` fails *closed*, alone in this client.** `plugins.ts` fails open
  because a dropped block costs a row nobody sees; a half-read entry is a half-read
  **permission list**, where somebody grants access to their sessions.
  An unknown schema draws "update the app", never a partial parse; an **empty**
  catalogue is `ok`. `sha256Seen` is shown at most and **never a gate** — GitHub's
  tarballs are not byte-stable, so the pin is the commit.
  ⚠ **Closed means a required field missing or wrong-typed — never an *unknown*
  one.** The service adds fields and never repurposes them, and `schema` moves only
  when that is not enough; a reader refusing unknown keys would go dark on every
  **already-deployed** client at the next addition, for people whose client is older
  than that deploy. `webcheck` pins the tolerance at all three depths.
- **Every address in a catalogue entry is built from the pin, and the only ones
  taken from the service are the ones it spells the same way.** `repo` is held to
  `src/plugins/source.ts`'s own expression beside `commit` — both are interpolated
  into a URL *path*, and a row the daemon would 400 is a row whose only button
  does not work. `manifestRaw` is **derived**, and a divergent one drops the
  entry: the market fetches it and the bytes that come back *are* the permission
  list, so a catalogue-chosen address is a catalogue-chosen disclosure — and
  `connect-src` lists the service's own origin, so one pointing home fetches
  perfectly. ⚠ **The consent checks downstream do not cover this, because of what
  they compare**: `consentGap` and `consentBroken` compare *scopes, `net` and
  hooks* and nothing else, so an under-declaring manifest is refused before the
  plugin starts — while `id`, `name`, `version`, `description` and the
  contributions are compared by neither, which is what a forged address bought.
  `browse` and `manifest` are `https` on `github.com` or they fall back to that
  same derivation — a person still gets the true link, and no plugin goes dark
  over the spelling of one — and an `icon` off `raw.githubusercontent.com` becomes
  `null`, the glyph rather than a missing plugin. Parsed with `new URL`, never
  prefix-matched: `https://github.com@evil.example/` is `evil.example`.
  ⚠ **This is not a refusal of unknown fields**, which the bullet above forbids:
  it drops an entry over a *present, correctly-typed* field whose value this build
  can show to be wrong about the pin — the rule `commit` has always had.
- **That mirror is now compared — where both copies are on one disk — and the
  *skip* is the load-bearing half.** `webcheck` reads the original off
  `services/plugins/src/catalogue.ts` when it is there and asserts **`client ⊆
  service`**: this side may be behind (the service adds fields and never repurposes
  them, and `readCatalogue` tolerates unknown ones), and may **not** declare a
  field the service does not send — `readOne` fails *closed* on a required field,
  so a name invented here, or renamed over there, takes the whole market dark
  rather than costing one row. ⚠ **Where the other repository is absent — which is
  every CI run — it prints a line saying so and naming the file it wanted.** A
  silent skip is a green tick about work nobody did, and for this pair skipping is
  not the edge case, it is the normal state. Both halves are driven: an invented
  field fails and names it, and a missing original prints the skip.
- ⚠ **`catalogue.ts` mirrors a file in a *different, private* repo** —
  `services/plugins/src/catalogue.ts` in `rends-east/reemoat-prod`, this being
  `rends-east/reemoat`. No import across that line: this CI has no copy of it,
  `deploy.sh` moves it with `git reset --hard`, and it would publish a private
  shape. The **manifest** types mirror `src/plugins/protocol.ts`, the original —
  never that service's copy, which would be a copy of a copy.
- **Coming here from the settings sheet is a *crossing*, and `under` cannot answer
  it.** `underFor` carries the path an overlay was drawn over **forward** when one
  overlay opens another, deliberately — that is what makes the ✕ always close onto
  a screen rather than reopening the pop-up underneath. So it is the wrong value
  for the ◀, and with only `under` recorded the way up fell through to `marketUp`,
  which answers *the market list* on the reasoning that "an entry is only ever
  reached from that list". That stopped being true the day `PluginsPanel`'s row
  became a link here: the ◀ pointed at a list nobody had opened, the ✕ left the
  stack entirely, and the machine somebody was configuring was five taps away.
  `origin` sits beside `under` in `history.state` — **per history entry, so it
  survives Back, Forward and a reload** — and `marketUpFrom` consults it at
  **exactly one depth**, an entry's. A tab still leaves the pop-up however it was
  reached and settings still walk to their own plugin first, one level at a time,
  which is what stops the ◀ and the ✕ becoming one control. ⚠ **A field added to
  `history.state` must degrade to the previous behaviour when absent**: every entry
  written before it existed, and every cold deep link, reads `null` — which is
  `marketUp`'s own answer. `originFor` and `overlayKind` are in **`nav.ts` and not
  `router.ts`**, and the move is the point: `router.ts` reads `window.location` in
  its module body, so nothing offline can import it, and the one round this
  decision spent in there a mutation inverted its comparison with every driver
  still green. `overlayKind` is the third member of the `isSheet`/`isOverlayPath`
  family and compares a **segment**, never a prefix — `/p/:machineId/:pluginId` and
  `/plugins` share four letters and are two different pop-ups.
- **A fleet install is cancellable, and the signal is the caller's.** `InstallAct`
  takes one as its fourth argument because a screen that mints its own has an
  upload nothing can call off — which shipped: `InstalledList` wrote
  `new AbortController().signal`, built and dropped in one expression, on the
  screen with the widest reach, while `PluginsPanel` one directory over documents
  that same defect in the past tense. ⚠ **Arity is not checked for you**: a
  two-parameter closure is silently assignable to a four-parameter `InstallAct`,
  and that is exactly how the market's own install went on dropping the signal
  while `MachineInstalls` drew the Cancel belonging to it. The guard is **per
  request** — `controller.signal.aborted`, never an act-wide flag, which silenced a
  *removal's* failure and killed the `plugin_busy` retry — and the button is drawn
  from what the act holds rather than from what the screen can do. `webcheck`
  asserts **linkage** here rather than presence, because presence is satisfied by a
  controller nothing listens to.
- **An import carries its archive's version or it cannot update anything.**
  Without `available`, `isBehind` is false on every row, so no row draws Update and
  the bar's Update is dead — leaving Remove as the only route to a newer copy on the
  screen whose purpose is putting a build onto a fleet, and Remove takes
  `plugin_data` with it: the destructive path as the only path.
- **`isSheet` and `isOverlayPath` must hold the same set.** One question from two
  directions: a route in one and not the other is a pop-up that either forgets what
  it was drawn over or records one while being a screen.
