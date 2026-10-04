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

A system sans in which monospace is reserved. Exactly **two** `font-family` declarations,
both tokens, in `index.css`: `body` at `--font-sans`, `pre, code, kbd` at `--font-mono`.
Every other mono is an explicit `font-mono` at a call site; `webcheck` prints the count, and
no prose restates it. **No web font, ever**: YaHei and Segoe UI cannot be shipped, and a CJK
substitute is 2–4 MB to a phone. Q3.579.

> **A machine-written string a person may retype or compare character by character is
> drawn in mono. A machine-written string that is prose is drawn in sans.**

`DirectoryPicker` states the test: *"that family is here because those are paths, and this
is a sentence about one there is no path for."*

- **Mono**: paths, ids, keys, a one-time secret, commands, diff bodies, code fences.
- **Sans**: the agent's replies, refusal text, every sentence *about* a path, and a
  person's own message, drawn verbatim in `pre-wrap` (Q3.646).
- **Never both for one fact.** Q3.579, Q3.580.

**A session-list row is sans throughout, title and subline: the one deliberate exemption.**
It is the tightest slot (at 390px the subline shares its width with the age and the overflow
control), and mono costs about a fifth of the characters. `sessionLabel` answers a typed title
or `displayCwd`; the subline is the nickname, `AgentMark` (Q3.680) and `MachineLabel`, one gap
apart, no path (Q3.681). One family, one size. Mono is for a path read *as a path* with room:
the session header's subtitle, the picker's crumbs, a diff's header, the import sheet.

**A mono run inside a sans line takes the step below it** (mono reads larger at an equal
size). Every path in mono is `text-2xs`: `DiffView`'s header, the picker's crumbs, and two
that inherit a `text-2xs` line (the session header's subtitle via `Header`, the import
sheet's footer). 12px is the floor, so a path is never what the eye lands on first.

**A background task's title changes family by the kind of work, mono as the fallback.** The
call site's condition is `task.taskType !== "workflow" && task.taskType !== "monitor"`: a
shell is `font-mono text-2xs`, a workflow or monitor `text-xs font-medium`, and anything a
later adapter sends lands in mono, the partition by which `tasks.ts` files an unknown
`taskType` under `Shells` (a shell's title is its command line; a workflow's is the script's
`meta.name`). The `monitor` arm is a call about the kind, not its strings: it also buckets
`mcp`, titled by `taskTitle`'s `description`, which nothing here has seen. One ternary at one
call site. The card uses `break-words`, not `truncate`.

**Everything that names a path goes through `displayCwd` or `pathCrumbs`** (`paths.ts`),
never a local helper. Q3.580.

## The scale

Six steps in `index.css`, `--text-2xs` through `--text-xl`, each with its line-height. The
root `font-size` is deliberately unset, so `1rem` stays the reader's. The app lives at
`text-2xs` and `text-xs`; `text-2xl` and `text-3xl` do not exist, by design.

**Under a finger the whole scale is two pixels up** (the owner's word): one `@layer theme`
block under `@media (pointer: coarse)` restates all six steps and line-heights, keyed on the
pointer, never a breakpoint. The two count badges step `h-4` to `h-5`; the one arbitrary size
stays. Q3.662.

- **Every size comes from the scale.** Exactly **one** arbitrary size, `text-[11px]` on the
  installer line in `CommandLine.tsx`, named in the driver's allowlist; a second fails
  `webcheck`.
- **Form controls are exempt, unlayered**: `input, textarea, select` are `max(16px, 1em)`,
  reverted under `@media (pointer: fine)`, because iOS Safari zooms into a smaller field and
  does not zoom back. Unlayered beats Tailwind's utilities without `!important`; on touch
  every field, mono included, is larger than its class says.
- **Never restate a pixel count in a docblock** (`MENU_HEADING`'s once named a size gone);
  argue in steps. The exception is a pixel that is the subject, like iOS's 16px threshold.

## Nothing in this client changes the mouse

No `cursor` declaration and no `cursor-*` utility anywhere in `packages/web/src`, with
exactly three named exceptions: the separators' `col-resize`, the text caret on the
conversation header's in-place session name (Q3.665), and the pointer over a clickable
`@name` pill (Q3.682). The owner's rule: no module changes the mouse from its default
(Q3.627). The control answers instead: `.tap`'s 120ms colour transition, `hover:bg-raised` on
rows, `hover:text-fg` on captions. That a `text-muted hover:text-fg` caption at rest is
identified by nothing is a cost no driver can see.

- **A sweep over `src/`, never one file**: an unlayered declaration, other whitespace, a
  utility in a `.tsx` (Tailwind emits from source text) and `style={{ cursor: … }}` all pass
  a regex on `index.css`. `webcheck` walks the list that takes `.css` too; `srcFiles()` is
  `.ts`/`.tsx` only.
- **The class spelling may not appear even in a comment**: Tailwind's scanner reads comments
  and all of `packages/web`, `scripts/` included. Describe the value (`col-resize`,
  `pointer`). The utility arm runs over **raw** source in both authored trees; the
  declaration arm is comment-stripped.
- **The declaration arm is anchored on a cursor value, never `cursor:` alone** (`wire.ts`
  declares `cursor: number`); a control asserts it does not match.
- **`col-resize` is inside the sweep**, its files named in the allow-list; an exception is a
  file somebody adds there.
- **Anchors are out of scope**: real `<a>` elements take the hand from the user agent. The
  claim is about what this app sets.

## A long document, and its measure

`COLUMN` (`ui/bits.tsx`) is the only reading measure: a page of prose takes it, never
`GateCard`'s `max-w-sm` (four fields) or a third width. The body size is stated once, on the
column, and the blocks under it carry rhythm only; `webcheck` pins both halves. A list uses
the transcript's `ml-4 list-disc` / `pl-0.5`, with `space-y-1` rather than `space-y-0.5`.
`legal-pages.md` is the area.

## The caps idiom: two constants, and the label that left them

`text-2xs font-semibold tracking-wider … uppercase` is one idiom with two owners, and **which
one is a colour decision, never a size decision.** Compose layout onto them; never restate
the type.

| Constant | Where | Tone |
|---|---|---|
| `SETTINGS_HEADING` | a named band of anything — a settings group, a plugin's column, a table head | `text-muted` |
| `MENU_HEADING` | inside a popover; carries its own `px-2.5 py-1.5` because it shares a left edge with the rows under it | `text-faint` |

**A field's name is not a heading**: `FIELD_LABEL` (`ui/kit/Field.tsx`) is sentence case,
`text-xs font-medium text-fg` (Q3.685), in the no-colour-appended sweep but not the census.
`SETTINGS_HEADING` labels no field anywhere, the gate included. Its name is narrower than its
reach and stays: `docs/DECISIONS.md` cites the symbol and `docscheck` asserts it.

**Extracting a constant does not retire an idiom** (Q5.115). **Three** sites spend it
outside the constants on purpose, each with a comment closing immediately above it:

- `AgentBuilder`'s `HIDDEN_PROVIDER_HEADING`: `text-faint`, written out rather than
  `` `${SETTINGS_HEADING} text-faint` ``.
- `MenuDrawer`'s `DRAWER_HEADING`: `text-faint` at that panel's `px-3`, since `MENU_HEADING`'s
  `px-2.5` puts the word 2px inboard of its rows.
- `TaskPanel`'s `FINISHED_HEADING`: `text-faint` on both arms of the finished band, so the
  fold and its empty form share a tone.

`MachineSection`'s `RETIRE_HEADING` is gone (a `DangerRow`, Q3.686); `webcheck.typography.ts`
asserts it and a danger-coloured copy absent, and holds the set as a **census**: every file
spending the idiom with its hit count, differenced against
`grep -rn 'tracking-wider' packages/web/src` less `ui/bits.tsx` over comment-stripped source. A new site fails as
found-not-listed, a deleted one as listed-not-found. A census, never a `length === N`.

**The background panel's head is spelled out at `min-h-11`**, not composed from
`SHEET_HEAD` (56px). `` `${SHEET_HEAD} min-h-11` `` cannot shorten it: two `min-h-*`
resolve by ascending emission order, so composition only adds. Inverting `SHEET_HEAD` to 44
and letting `Sheet` compose 56 back is refused: a height would depend on which number is
larger. 44, not 40: `ICON_BUTTON_SIZE` reaches the floor through a positioned `::after` and
the `<aside>` is `overflow-hidden`, clipping hit-testing; that `::after` is
`[@media(pointer:coarse)]:` only, as a pad extends `:hover` too (Q3.634). Q3.629.

**The background panel has three heading treatments, one a constant.** `PanelHeading`
(`Agents (2)`, `Shells (10)`, …) is `SETTINGS_HEADING`. The panel's own `Background` is
`text-xs`, asserted as strictly quieter than `SessionTitle`: a nested pop-up, not the
screen's name. `Phases` is outside the idiom (`text-2xs font-medium text-fg`, no
`tracking-wider`, no `uppercase`), over a frame. Choosing between the caps constants is a
colour decision; the dialog title or `Phases` is a different treatment.

**A colour cannot be appended to one of these**: `` `${SETTINGS_HEADING} text-danger` `` is a
silent no-op, resolved by Tailwind's alphabetical emission, not string order.
`menuRow(align)` closes the same trap, and `webcheck` sweeps every shared class string for
it.

## What is checked

`webcheck.typography.ts`:

1. **Two families, both tokens**: a third `font-family` in `index.css`, or a literal stack,
   fails.
2. **No web font loads**: `@font-face`, `googleapis`, `gstatic`, `.woff` over the stylesheet
   and the HTML shell, comments stripped first (`--font-sans`'s docblock mentions woff2).
3. **Every size is from the scale**, the one exception named in the driver.
4. **Not the landing page**: since its 2026-09-24 rebuild it has its own type (`--sans`,
   `--mono`, a serif, `rem` sizes), so nothing is shared to compare. Q7.133.

**Every sweep carries a floor**: a regex that matches nothing passes silently. Q5.114.
