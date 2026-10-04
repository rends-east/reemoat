---
paths:
  - packages/web/src/ui/bits.tsx
  - packages/web/src/ui/kit/*
  - packages/web/src/ui/settings/*
  - packages/web/scripts/webcheck.kit.ts
---

# One control per question

Two files of primitives, not a library (Q3.683): `ui/bits.tsx` (`Button`, `IconButton`,
`TwoStep`, `Dropdown`, `Menu`, the class constants) and `ui/kit/` (the families since).
**Find the primitive that answers the question; if none does, add one to the kit, never a
local component.**

| The question | The control |
|---|---|
| Type a value | a `Field` around an `<input className={FIELD}>`, on a leaf screen |
| Choose one of N | `Dropdown` — `variant="field"` in a form, `"row"` in a settings group, `"icon"` in a toolbar |
| Pick several | a native `<input type="checkbox" className={CHECKBOX}>`, in the palette's ink |
| On or off | `SwitchRow` |
| Go deeper | `LinkRow` |
| Do one thing | `ActionRow` (`tone="danger"` for a one-tap act that ends something) |
| Act on a record | `RowMenu` with `RowAction`s; a destructive act confirms through `TwoStep` |
| Destroy something | a `TwoStep` whose rest is a `DangerRow`, or a `DangerButton` (the glyph is required) |
| A set of records | a table (`TABLE`/`TD`) inside a `Group` |

## One height

`CONTROL` is `FIELD`'s height (`min-h-9`, `min-h-11` under a finger), spent by every dropdown
trigger and popover row; primary buttons and rows stay `min-h-11`. So everything is 44px
under a finger, and fields and popover rows are 36px under a mouse. `webcheck.kit.ts` asserts
`CONTROL` equals `FIELD`'s height class for class: `FIELD`'s literal is pinned where it is
declared, so it cannot be written as `${CONTROL}`.

## The dropdown (Q3.684)

- **A field's name is its `Field` label, beside it.** The trigger takes `id` and `labelledBy`
  from `Field`'s render prop and is named `label + trigger`. **No heading in a field's
  panel**: `heading?: never` on the field member.
- **A field's panel is exactly its trigger's width** (`inset-x-0`). An icon's panel grows to
  its longest row, 10rem to 20rem, from the icon's edge, and only an icon may head its panel
  (there the heading is the label). A row is a whole `GROUP_ROW`: title left, value and
  chevron right, panel from the row's end.
- The chosen option has a 14px check on the trailing edge; the highlighted row is
  `bg-raised`.
- Direction is measured at the tap (`menuPlacement`). Focus returns to the trigger found by
  `triggerIn`, never `document.activeElement` (the body after a click, in WebKit).
- **No native `<select>` anywhere in `src/`** (Q3.463).
- Every popover is one box: `MENU_BOX`, and `MENU_PANEL` (capped at `MENU_MAX_PX`) for
  `Menu` and `Dropdown`; the composer's two menus cap it at their own height.

## A settings screen is a stack of groups (Q3.686)

`Group` (`ui/kit/List.tsx`): an optional caps title with a count and one action, one
bordered box of rows split by hairlines, an optional footer. **A row is exactly one of**
`LinkRow`, `ValueRow`, `ActionRow`, `SwitchRow`, `ChoiceRow`, a `Dropdown` row, a record
table, `EmptyRow`, or a `TwoStep` row (`TWO_STEP_ROW`) whose rest is a `DangerRow` or a
`Button`. Any other shape is a kit entry first.

- The box is `edge-strong` and its rows carry no border, so a row's glyph identifies it
  (`web-shell.md`). A record row may end in one `Button size="sm"`. A box with no control
  (the log) is `still` and takes the hairline.
- **The box never clips**: popovers are absolute, so `GROUP_ROW`'s `first:`/`last:` rounding
  rounds the corner rows' fill.
- A table whose rows can arm a `TwoStep` is `table-fixed` with column widths; the armed row
  is one cell spanning them (Q3.218).
- **Nothing appears inside a screen**: every form and one-time secret is a leaf
  (`SettingsLeaf`); a secret is minted on the row's tap, never on mount, and handed over in
  module state (Q3.549).
- A group title never repeats the screen's name; such a first group is untitled.
- **A subline wraps; a title truncates.** A switch, choice or dropdown row's subline takes a
  second line on a phone rather than losing its end. A title keeps a 40% floor against a long
  value; a `Badge` never wraps or shrinks.
- Two rows spend `GROUP_ROW` directly, on purpose: the sign-in wizard's page step (an `<a>`
  the native-bridge census reviews at its call site) and its device code (read once, so a
  real fill). `OneTimeSecret`'s box is the one box drawn by hand.

**What a screen may say** is Q3.544's table: a row's title is a noun, its value at the
trailing edge; a subline only on a switch or choice row, eight words at most; a footer only
for a consequence at rest, six words at most; an act's consequence in its confirmation or on
its leaf; no caveat, no meta text, nothing restating a heading. An error goes under the group
(`Group`'s `error`), never inside the box.

## A label beside its control

`FIELD_LABEL` is sentence case (Q3.685); caps belong to `SETTINGS_HEADING` and
`MENU_HEADING` alone. `Field` draws the `<label>` as a **sibling** bound by `htmlFor`, then
the control, then a hint or error via `aria-describedby`. A `<label>` never wraps a
`Dropdown` trigger: it activates its first labelable descendant (`plugin-ui.md`).

## The kit's one-way rule

`kit/` may import from `bits.tsx`; `bits.tsx` imports nothing from `kit/`. `bits.tsx` is
already in a cycle with `Toast.tsx`, safe only because each reads the other inside function
bodies; a module-level `${FIELD}` across a `bits`↔`kit` cycle throws at load, on the gate
page too. `webcheck.kit.ts` walks each kit module's value imports against the transport
modules and `version.ts`.

## What is checked

`webcheck.kit.ts`: the field panel's width and absent heading, the trigger's accessible
name, direction at the tap, `CONTROL` against `FIELD`, focus returned to the trigger, no
`<select>`, a sentence-case `FIELD_LABEL` beside its control and never around it, and the
kit's import closure. Over the settings screens: no `SETTINGS_SECTION` band, a kebab only
through `RowMenu`, and two censuses by file (boxes drawn by hand, muted paragraphs) that
count sites, not words (Q3.544 refused a word budget). Every checkbox in `src/` carries
`CHECKBOX`. The Dropdown's refusal looks (a disabled trigger keeps its border, a refused
option its reason at full strength) are `webcheck.refusing-controls.ts`'s.
