---
paths:
  - packages/web/src/ui/bits.tsx
  - packages/web/src/ui/kit/*
  - packages/web/src/ui/settings/*
  - packages/web/scripts/webcheck.kit.ts
---

# One control per question

The web client has a design system, and it is two files of primitives rather than a
library (Q3.683). `ui/bits.tsx` holds what the drivers already read there — `Button`,
`IconButton`, `TwoStep`, `Dropdown`, `Menu` and the class constants. `ui/kit/` holds
the families added since. **Before drawing a control, find the primitive that answers
the question; if none does, add one to the kit rather than a local component.** The
owner's brief, 2026-09-28, was that too many elements were one-offs, and three
inventories had counted eight minimum heights and three menu implementations to prove
it.

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

`CONTROL` is `FIELD`'s height — `min-h-9`, reaching `min-h-11` under a finger — and
every dropdown trigger and popover row spends it. Primary buttons and rows stay
`min-h-11`. **Everything is 44px under a finger**; under a mouse, fields and popover rows
are 36px. `webcheck.kit.ts` asserts `CONTROL` is `FIELD`'s height class for class,
because `FIELD`'s own literal is pinned where it is declared and cannot be written as
`${CONTROL}`.

## The dropdown

- **A field's name is its `Field` label, beside it.** The trigger takes `id` and
  `labelledBy` from `Field`'s render prop and names itself `label + trigger`, so a screen
  reader hears the value too. **No heading inside the panel**: `heading?: never` on the
  field member, since both call sites of the old prop spent it repeating the label.
- **A field's panel is exactly its trigger's width** (`inset-x-0`). An icon's panel grows
  to its longest row, from 10rem up to 20rem, from the icon's edge — and only an icon may head
  its panel, because there the heading *is* the label. **A row** is a whole `GROUP_ROW`: its
  title on the left, the value and a chevron on the right, the panel from the row's end.
- **The chosen option carries a 14px check on the trailing edge**, so an option's text
  starts where the trigger's does; the highlighted row is `bg-raised`.
- **The direction is measured at the tap** with `menuPlacement`, and focus comes back to
  the trigger found by `triggerIn` — never to `document.activeElement`, which in WebKit is
  the body after a click.
- **No native `<select>` anywhere in `src/`** (Q3.463, now asserted across the tree).
- **Every popover is one box**: `MENU_BOX`, and `MENU_PANEL` — the box capped at a height
  `MENU_MAX_PX` states — for `Menu` and `Dropdown`; the composer's two menus cap it at their
  own height.

## A settings screen is a stack of groups

**The owner chose grouped cards from three previews (2026-09-28)** — iOS and Telegram's
settings, over flat rows and a label-left form (Q3.686). `Group` (`ui/kit/List.tsx`) is
an optional caps title with a count and one action, one bordered box of rows split by
hairlines, and an optional footer. **A row is exactly one of** `LinkRow`, `ValueRow`,
`ActionRow`, `SwitchRow`, `ChoiceRow`, a `Dropdown` row, a record table, `EmptyRow`, or a
`TwoStep` row (`TWO_STEP_ROW`) whose rest is a `DangerRow` or a `Button`. A shape that is
none of them is a kit entry first.

- **The box is `edge-strong` and its rows carry no border**, so a row's glyph — chevron,
  knob, action glyph — is what identifies it (`web-shell.md`'s rule for a control inside a
  bounded container). A record row may carry one `Button size="sm"` at its end. A box that
  holds no control, such as the log, is `still` and takes the hairline.
- **The box never clips.** A menu or dropdown opened from a row is absolute, so the corner
  rows round their own fill; `GROUP_ROW` carries `first:`/`last:` rounding for that.
- **A table whose rows can arm a `TwoStep` is `table-fixed` with column widths**, and the
  armed row is one cell spanning them, so the question gets the width and Cancel lands
  where the act's button was (Q3.218).
- **Nothing appears inside a screen.** Every form and every one-time secret is a leaf
  (`SettingsLeaf`); a secret is minted on the row's tap, never on mount, and handed over in
  module state as the new key is (Q3.549).
- **A group title never repeats the screen's name**; a screen whose first group would be
  named for the screen leaves it untitled.
- **A subline wraps; a title truncates.** A switch, choice or dropdown row's subline is the
  one sentence the copy caps allow it, eight words at most, so it takes a second line on a
  phone rather than losing its end. A row's title keeps a 40% floor against a long value,
  and a `Badge` never wraps or shrinks — the value truncates first.
- **Two rows spend `GROUP_ROW` directly, on purpose**: the sign-in wizard's page step, an
  `<a>` the native-bridge census reviews at its call site, and its device code, one of the
  two values read once, which keeps a real fill. `OneTimeSecret`'s box is the one box drawn
  by hand.

**What a screen may say** is Q3.544's table, unchanged: a row's title is a noun and its value
sits at the trailing edge; a subline only on a switch or choice row, eight words at most; a
footer only for a consequence at rest, six words at most; an act's consequence in its
confirmation or on its leaf; no caveat, no meta text, nothing that restates a heading. An
error goes under the group (`Group`'s `error`), never inside the box as a row.

## A label beside its control

`FIELD_LABEL` is sentence case (Q3.685); caps belong to `SETTINGS_HEADING` and
`MENU_HEADING` alone. `Field` draws the `<label>` as a **sibling** bound by `htmlFor`,
then the control, then a hint or an error attached by `aria-describedby`. A `<label>`
never wraps a `Dropdown` trigger: it activates its first labelable descendant, which is
how a plugin form's help paragraph came to open the picker (`plugin-ui.md`).

## The kit's one-way rule

`kit/` may import from `bits.tsx`; `bits.tsx` may import nothing from `kit/`. `bits.tsx`
already sits in a cycle with `Toast.tsx` that is safe only because each side reads the
other inside function bodies, and a module-level `${FIELD}` composed across a
`bits`↔`kit` cycle throws at load — on the gate page too, which imports `bits.tsx`.
`webcheck.kit.ts` walks each kit module's value imports against the transport modules
and `version.ts`.

## What is checked

`webcheck.kit.ts`: the field panel's width and the absent heading; the trigger's
accessible name; the direction taken at the tap; `CONTROL` against `FIELD`; focus
returned to the trigger; no `<select>`; a sentence-case `FIELD_LABEL` drawn beside its
control, never around it; and the kit's import closure. Over the settings screens: no
`SETTINGS_SECTION` band; a kebab only through `RowMenu`; and two censuses by file — the
boxes drawn by hand and the muted paragraphs — so a new one is a table row added on
purpose rather than drift, which counts sites and not words (Q3.544 refused a word
budget). Every checkbox in `src/` carries `CHECKBOX`. The Dropdown's refusal looks —
a disabled trigger keeps its border, a refused option keeps its reason at full strength
— are `webcheck.refusing-controls.ts`'s, as before.
