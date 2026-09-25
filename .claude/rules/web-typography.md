---
paths:
  # The stylesheet that *defines* the scale and both families was in no rule's
  # globs at all, so opening it summoned nothing. That is the gap this file
  # closes, and it is why `bits.tsx` is claimed here as well as by
  # `web-shell.md`: the three heading constants live there, and a change to one
  # of them is a typography change before it is a shell change.
  - packages/web/src/index.css
  # The judgement-call sites for the cursor ban below: the app's only
  # `<summary>`, and the two resize separators. A rule scoped away from the file
  # it governs is the one `docscheck` failure with no symptom.
  - packages/web/src/ui/AppShell.tsx
  - packages/web/src/ui/PaneHandle.tsx
  - packages/web/src/ui/SessionView.tsx
  - packages/web/src/ui/settings/AgentsPanel.tsx
  - packages/web/src/ui/bits.tsx
  - packages/web/src/paths.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/PermissionCard.tsx
  - packages/web/src/ui/DiffView.tsx
  - packages/web/src/ui/Markdown.tsx
  - packages/web/src/ui/ImportCode.tsx
  # The background panel is where this release's sharpest mono-vs-prose call is
  # made — one card title drawn in mono or in sans by the *kind* of work it
  # names, with mono as the fallback. `tasks.ts` decides every string it draws,
  # so the two arrive together or the call is read with half its argument
  # missing.
  - packages/web/src/ui/TaskPanel.tsx
  - packages/web/src/tasks.ts
  - packages/web/src/ui/settings/*
  - packages/web/scripts/webcheck.typography.ts
---

## Two families, and what decides which

**This app is a system sans in which monospace is reserved, not a monospace app.**
There are exactly **two** `font-family` declarations in the whole front end, both
tokens: `body` at `--font-sans` and `pre, code, kbd` at `--font-mono`, in
`index.css`. Every other mono is an explicit `font-mono` at a call site, and
`webcheck` prints how many rather than this file stating it — the number was
written here by hand as *38* and was wrong inside the same change that wrote it,
because two call sites were added three files away. A count restated in prose is
the one kind of claim this repository has learned not to keep.
**There is no web font and there will not be one**: YaHei and Segoe UI are
Microsoft's and cannot be shipped, and a free CJK substitute is 2–4 MB of woff2 out
of the control plane's own container to a phone on LTE. Q3.579.

The terminal feel is not the default face. It is *which surfaces* landed in the mono
channel — the transcript, diffs, paths, keys, command lines — which is to say the
ones people look at longest.

**The rule a change here must not break:**

> **A machine-written string a person may retype or compare character by character
> is drawn in mono. A machine-written string that is prose is drawn in sans.**

`DirectoryPicker` states it at one of the places that got it right, and the sentence
is worth keeping in mind because it is the whole test: *"that family is here because
those are paths, and this is a sentence about one there is no path for."*

- **Mono**: paths, ids, keys, a one-time secret, commands, diff bodies, code
  fences — anything transcribed into a terminal or compared against one.
- **Sans**: the agent's replies, refusal text, every sentence *about* a path — and
  a person's own message, which is drawn verbatim in `pre-wrap` and is still
  somebody's prose rather than a machine's string (Q3.646).
- **⚠ Never both for one fact.** This rule was followed from memory for four
  releases and had already been missed four times, all of them one workspace path
  drawn in mono by the picker and in sans everywhere else. Q3.579, Q3.580.

**A row in the session list is sans throughout — title *and* subline — and that is
the rule's one deliberate exemption.** A row is the tightest slot in the app: at
390px the subline shares its width with the age and the overflow control. Mono's
~0.6em average advance against sans's ~0.5em spends about a fifth of the characters
on the family, and a row exists to be *scanned*, so characters are the whole of what
it has to spend. `sessionLabel` answers a human-typed title or, failing that,
`displayCwd`; the subline names the agent, the machine and what is left of the path.
All of it is sans, at one size, because a line that changed family halfway is what
made the row unreadable when this was first tried.

Mono is for where a path is being read *as a path* and there is room to read it: the
session header's subtitle, the picker's crumbs, a diff's header, the import sheet.

**⚠ A mono run inside a sans line takes the step below it.** Mono reads *larger*
than sans at an equal nominal size — SF Mono's x-height and advance against SF
Pro's — so it does not inherit the line's size, it states one. The session row
proved it twice over: made mono and left to inherit its line's `text-xs`, the path
landed level with the row's own `text-sm` title (*"the folder name is the size of
the session name"*), and stepped down to `text-2xs` it was still too wide to read
(*"too few characters fit"*) — which is what took that row out of mono altogether.
Every path drawn in mono is `text-2xs`: `DiffView`'s header, the picker's crumbs,
and the two that inherit a `text-2xs` line already (the session header's subtitle,
via `Header`, and the import sheet's footer). **12px is the floor**, so a path can
never be the thing a reader's eye lands on first.

**A background task's title changes family by the *kind* of work it names, and
mono is the fallback rather than the exception.** The condition at the call site is
`task.taskType !== "workflow" && task.taskType !== "monitor"`, so a shell is
`font-mono text-2xs`, a workflow and a monitor are `text-xs font-medium`, and
**anything else a later adapter sends lands in mono**. That default is the same
partition `tasks.ts` files an unknown `taskType` under `Shells` by, and for the
same reason: the fallback kind is *a thing the agent ran*, and a backgrounded
shell's title **is** its command line — the adapter recovers it from the Bash tool
result. The two named exceptions are the kinds whose title is a name somebody
wrote, a workflow's coming from the script's `meta.name`. ⚠ **The `monitor` arm is
a call about the kind, not a measured claim about the strings in it**: `monitor` is
also the adapter's bucket for `mcp`, and `taskTitle` gives every non-workflow kind
its `description` first, so an mcp task's title is whatever that description is and
nothing in this tree has seen one. One ternary at one call site decides all of it,
which is what keeps a card from becoming two components that disagree, and the mono
half takes the step below the sans half for the reason the session row proved
twice. The card is also where `break-words` beats `truncate`: it is not a row, and
the part of `python3 -c "impo…"` a `truncate` would cut is the part somebody opened
the panel to read.

**Everything that names a path goes through `displayCwd` or `pathCrumbs`**
(`paths.ts`), never through a local helper. The import sheet had its own,
disagreeing with the breadcrumb bar three inches above it, and its docblock claimed
parity it did not have. Q3.580.

## The scale

Six steps in `index.css`, `--text-2xs` through `--text-xl`, each with its own
line-height. **The root `font-size` is deliberately unset**, so `1rem` stays the
reader's setting.

The app lives at 12–13px: `text-2xs` and `text-xs` are ~300 of ~430 uses,
`text-2xl` and `text-3xl` do not exist. That is a density decision, not an
oversight.

**Under a finger the whole scale is two pixels up**, on the owner's word: one
`@layer theme` block under `@media (pointer: coarse)` restates all six steps and
their line-heights, so no call site changes and a phone reads 14–16px. Keyed on the
pointer, never a breakpoint, as the 16px field rule is. The two count badges step
from `h-4` to `h-5` with it. The one arbitrary size stays where it is. Q3.662.

- **Every size comes from the scale.** There is exactly **one** arbitrary size in
  the app — `text-[11px]` on the installer line in `CommandLine.tsx` — and it is
  named in the driver's allowlist rather than tolerated silently. A second one
  fails `webcheck`.
- **⚠ Form controls are exempt and the exemption is unlayered.** `input, textarea,
  select` are `max(16px, 1em)`, reverted under `@media (pointer: fine)`. iOS Safari
  zooms the viewport on focus into a field under 16px and does not zoom back out.
  The rules are unlayered so they beat Tailwind's utilities without `!important`.
  Cost: on a touch device every field is larger than its class says, mono ones
  included.
- **Do not restate a pixel count in a docblock.** The scale moved up a notch once
  and left four comments describing sizes that no longer existed — `MENU_HEADING`
  called 10px when it is 12px, a 12px floor that is now 13px. Argue in *steps*,
  which is what every one of those comments was actually about. The exception is a
  pixel that is genuinely the subject rather than a restatement of the scale: the
  16px zoom threshold above is a fact about iOS Safari, not about `--text-sm`.

## Nothing in this client changes the mouse

**There is no `cursor` declaration and no `cursor-*` utility anywhere in
`packages/web/src`, with exactly two named exceptions** — the separators'
`col-resize`, and the text caret on the conversation header's session name, which
is edited in place (the owner's word, Q3.665). `index.css` carried an
`@layer base` rule putting the hand shape on every enabled `button`, every
`[role="button"]` and the one `<summary>` — restored on purpose after Tailwind v4's
preflight dropped it, on the argument that with the accent colour gone an unfilled
button is drawn in the colour of what it sits on, so the pointer's shape was the
one thing left separating a control from a caption. **That argument was true and it
is not the decision.** The owner's rule is that no module here changes the mouse
from its default and nothing is to make it react. Q3.627.

**Everywhere else the control answers, not the pointer.** `.tap` carries a 120ms
colour transition, rows take `hover:bg-raised`, captions take `hover:text-fg`. The
cost is real and unassertable: a `text-muted hover:text-fg` caption button at rest is now identified
by nothing, and no driver in this repository can see that.

⚠ **The ban is a sweep over `src/`, never the absence of a rule in one file.**
Three different wrong states satisfy a regex on `index.css` alone: the declaration
written unlayered, the same one with other whitespace, a utility class in a `.tsx` —
which Tailwind emits from *source text*, so it never reaches the stylesheet to be
found there — and `style={{ cursor: … }}`, the form React code actually reaches for,
which the first version of the pattern could not see at all. `webcheck` walks the one file list that takes `.css` as well as
`.tsx`; `srcFiles()` is `.ts`/`.tsx` only, so a sweep built on it would leave the
stylesheet unread and the rule could survive behind a green check.

⚠ **The class spelling may not appear even in a comment, and that is the sharper
half.** This repository keeps its history in its docblocks, so the natural way to
record a deleted utility is to name it — and Tailwind's scanner does **not** strip
comments, and reads every file under `packages/web`, `scripts/` included. Measured:
the driver's own positive control, written out as a literal, compiled the banned
rule into both shipped stylesheets while printing `ok`. So describe the *value*
(`col-resize`, `pointer`) and never the class; the utility arm is run a second time
over **raw** source across both authored trees to enforce it, while the declaration
arm stays comment-stripped so this paragraph is not itself an offender.

⚠ **The declaration arm is anchored on a cursor *value*, never on `cursor:`
alone** — `wire.ts` declares `cursor: number` for the transcript's byte cursor, and
a bare colon makes the wire protocol an offender, which is a red gate whose only
available repair is loosening the pattern. A control asserts that it does not.

⚠ **`col-resize` on the two separators is *in* the sweep rather than exempt from
it.** The instruction is about the mouse, not about which control earns an
exception — and the resize handles arrived in the same change, so carving them out
would have been adding the second violation while removing the first. Naming a file
in the allow-list is how a shape comes back: a diff somebody writes rather than a
precedent they find.

**Anchors are out of scope and cannot be in it.** The eight real `<a>` elements take
the hand from every user-agent stylesheet, and reclaiming it would mean this app
setting a cursor — the thing being banned — on the only elements whose shape is
universally understood. The claim is about what this app sets.

## A long document, and the measure it is set to

`COLUMN` (`ui/bits.tsx`) is the app's **only reading measure** and the transcript
already reads at it. A page of prose takes it, never `GateCard`'s `max-w-sm` —
that is a measure for four fields, and a policy set to it is a column about forty
characters wide. Inventing a third width is a second arbitrary measure with no
argument behind it.

**The body size is stated once, on the column, and the blocks under it carry
rhythm only.** That is the pair already asserted for the two mono spans that
inherit their line's step: a size on a container with no blocks under it passes
trivially, and a size on every block drifts apart one edit at a time. `webcheck`
pins both halves.

A list in a document uses the transcript's own `ml-4 list-disc` / `pl-0.5` so the
app has one list treatment — with `space-y-1` rather than `space-y-0.5`, argued
rather than copied: an item in a policy is a sentence and the tighter rhythm reads
as a wall. `legal-pages.md` is the area.

## The three caps constants

`text-2xs font-semibold tracking-wider … uppercase` — small caps with tracking — is
one idiom with three owners, and **which one is a colour decision, never a size
decision.** Compose layout onto them; never restate the type.

| Constant | Where | Tone |
|---|---|---|
| `SETTINGS_HEADING` | a named band of anything — a section, a form field's label on the gate, a plugin's column, a table head | `text-muted` |
| `MENU_HEADING` | inside a popover; carries its own `px-2.5 py-1.5` because it shares a left edge with the rows under it | `text-faint` |
| `FIELD_LABEL` | a field's name on a settings form. One step larger on purpose: a heading is scanned, a label is read off a form somebody is filling in from a phone | `text-muted` |

`SETTINGS_HEADING`'s name is narrower than its reach and stays that way — renaming
it would break the citation `docs/DECISIONS.md` makes of the symbol, which
`docscheck` asserts.

**Extracting a constant does not retire an idiom.** The string was written out
fourteen times before `SETTINGS_HEADING` existed; the count did not fall afterwards,
it moved — fifteen copies in thirteen files, nine of them using none of the three
constants, two of them byte-identical local `const label` declarations in two files
that never imported from each other. Nothing had ever swept for the idiom, so the
second wave was invisible until somebody counted. Q5.115.

**Four** sites spend the idiom outside the constants **on purpose**, and every one
of them says so at the code: `MachineSection`'s `RETIRE_HEADING` (`text-danger`),
`AgentBuilder`'s `HIDDEN_PROVIDER_HEADING` (`text-faint`, written out
rather than `` `${SETTINGS_HEADING} text-faint` `` and saying why), `MenuDrawer`'s `DRAWER_HEADING` (`text-faint` at that panel's own `px-3`, because
`MENU_HEADING` carries `px-2.5` and put the word 2px inboard of the rows it heads),
and `TaskPanel`'s `FINISHED_HEADING` (`text-faint`, spent by **both** arms of the
finished band — every other heading in that panel names work that is *going*, and
splitting the tone across the fold and its empty form would change the band's
colour at the one moment nothing about it has changed).
`webcheck.typography.ts` names `RETIRE_HEADING` and `HIDDEN_PROVIDER_HEADING` in
the same breath, as the two spelled out to avoid appending a colour. The sweep that
finds them all is `grep -rn 'tracking-wider' packages/web/src` less `ui/bits.tsx`;
`SettingField`'s hit is `FIELD_LABEL`, i.e. one of the three constants rather than
an exception to them — the third constant, and the one that does not live in
`bits.tsx`.

⚠ **This said *four* for a release, and nothing could see that it had stopped being
true** — it then said *five*, and the same thing happened again; it says *four* again
because the waiting band is gone (Q3.674). `DRAWER_HEADING` arrived with its own docblock arguing for itself, and the
only sweep that existed was for a *colour appended to a constant*, which this is
not — so the number was the whole record of the set and the record was wrong. It is
not prose any more: `webcheck.typography.ts` carries the **census**, a table of
every file that spends the idiom with its hit count, differenced against the sweep
above over comment-stripped source. A sixth site fails it as *found, not listed*; a
deleted one fails it as *listed, not found*. A count could do neither, which is the
general shape — a census, never a `length === N`. It also requires a comment to
close immediately above each of the four, which is what makes the "says so at the
code" clause above enforced rather than asserted.

**The background panel's head is spelled out at its own height, and composing the
sheet's was a measured no-op.** `SHEET_HEAD` is 56px — a height argued for a
`text-lg` `<h1>` beside a 32px control — and this head carries a `text-xs` `<h2>`
and a 24px one. ⚠ **`` `${SHEET_HEAD} min-h-11` `` cannot shorten it**: two
`min-h-*` utilities on one element are resolved by the sheet's emission order,
which is numeric and ascending, so composition only ever adds. Inverting
`SHEET_HEAD` to 44 and letting `Sheet` compose 56 back **would** work — upward is
the direction that order permits — and is refused by name for that reason: it makes
a height depend on which of two numbers is larger, and hands the next person a
revert that fails in silence. 44 rather than 40 because every `ICON_BUTTON_SIZE`
entry reaches this app's floor through a positioned `::after`, and the panel's
`<aside>` is `overflow-hidden`, which clips hit-testing along with paint. ⚠ That
`::after` is `[@media(pointer:coarse)]:` now — a pad extends `:hover` exactly as far
as it extends hit-testing, and the ✕ in this head lit up 10px early because of it
(Q3.634) — so the clipping argument holds under a finger and there is nothing to
clip under a mouse.

**The background panel carries three heading treatments at once, and exactly one
of them is a constant.** `PanelHeading` — `Agents (2)`, `Dynamic workflows (1)`,
`Shells (10)`, `Completed (3)` — is `SETTINGS_HEADING`, because a band naming a
section over the rows it holds is the whole of what that constant is for, and
`text-muted` is the right tone for a label a reader scans past to reach a card.
The panel's own `Background` is `text-xs`, and it is the one title in this app
asserted as a **comparison** rather than at a size: strictly quieter than
`SessionTitle`, whatever either becomes. ⚠ **That reverses what this said**, which
was `text-lg` on the argument that a quieter title claims this pop-up is a lesser
one. It is not a lesser pop-up — it is a *nested* one, a sub-window inside the
screen whose name is right beside it, and at `text-lg` it announced itself more
loudly than the conversation it is about. The claim that moved is which question
the size answers: not "is this pop-up important" but "is this the name of the
screen". And `Phases` is not an exception to
the constants at all — it is outside the **idiom**: `text-2xs font-medium text-fg`,
with no `tracking-wider` and no `uppercase`, so the sweep above does not even reach
it. It is louder than the box beneath it and sits over a frame rather than at the
head of a list, where a caps band would read as a second card's header — and its
own comment in `TaskPanel.tsx` makes exactly that argument, naming these three
constants and declining the idiom itself, so it says so at the code the way the
four above do. Choosing between the three caps
constants stays a colour decision, because they are one idiom at three tones;
choosing the dialog title or `Phases` instead is not — those differ in size, weight
and case as well, and that is a different treatment rather than a different tone.

**⚠ A colour cannot be appended to one of these.** `` `${SETTINGS_HEADING}
text-danger` `` is a silent no-op: two members of one family, resolved by Tailwind's
alphabetical emission and not by the order in the string. `RETIRE_HEADING` is spelled
out for exactly that reason. The same trap is what `menuRow(align)` exists to close,
and `webcheck` sweeps every shared class string for it.

## What is checked

`webcheck.typography.ts`. Nothing checked any of this before — a changed stack, a new
web font or a drift from the landing page would have passed all eight drivers.

1. **Two families, and both are tokens.** A third `font-family` anywhere in
   `index.css` fails, as does a literal stack written in place of a token.
2. **No web font loads** — `@font-face`, `googleapis`, `gstatic`, `.woff` over the
   stylesheet and the HTML shell. Comments are stripped first, because
   `--font-sans`'s own docblock discusses woff2 in prose.
3. **Every size is from the scale**, with the one exception named in the driver.
4. **The landing page has not drifted** — and it **`skip()`s in CI**. Q7.133.
   `services/landing/index.html` is a hand-copy of both stacks and five of the six
   scale steps, and it lives in the *other* repository, so the comparison only runs
   where both are on one disk. Absent, it says so and is counted; it must never
   print `ok`. Its scale is asserted as a **subset**, because the landing has no
   `--text-xl` and legitimately should not.

**Every sweep here carries a floor.** A regex that matches nothing passes silently,
which is the failure mode of every source-text assertion in `webcheck` — see
Q5.114, which is four of them found green over broken code.
