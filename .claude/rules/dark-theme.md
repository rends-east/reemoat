---
paths:
  - packages/web/src/index.css
  - packages/web/src/theme.ts
  - packages/web/public/theme.js
  - packages/web/index.html
  - packages/web/gate.html
  - packages/web/src/ui/MenuDrawer.tsx
  - packages/web/src/main.tsx
  - packages/web/src/gate-main.tsx
  - packages/native/src-tauri/src/seats.rs
  - packages/web/scripts/webcheck.theme.ts
---

# Two palettes, one set of names

The app has a light palette and a dark one, and **no component knows which is on.**
Both are the same fifteen `--color-*` tokens: the light values in `index.css`'s
`@theme` block, the dark ones in the unlayered `:root[data-theme="dark"]` block
after it. A component writes `bg-surface`; what that paints is the stylesheet's
business. Q3.669 is the argument, Q3.670 the switch.

## What a token owes in both

A dark value is not an inversion of the light one. It keeps its twin's **job** and
its **ratio to `surface`**, and `webcheck.theme.ts` computes all of it in both
palettes from one table:

- every text tone — `fg`, `muted`, `faint`, `danger`, `caution` — clears 4.5:1 on
  every paper (`ink`, `surface`, `raised`);
- `edge-strong`, a control's only boundary, clears 3:1 on every paper;
- `raised` stays 1.22:1 from `surface` (the message you wrote, Q3.205), `edge` sits
  beyond it, and `ink` stays the rail's 1.06:1 hint (Q3.210);
- the diff's inks read on their own bands, and `fg` on both;
- `ink` reads on `fg`, since that pair is Send and the reversible approval.

In the dark palette **elevation reads lighter** — `ink` < `surface` < `raised` <
`edge` — and neither end is pure black or white. Both are asserted.

**A new colour token owes a dark twin in the same change.** The driver fails a light
token with no twin, a dark one with no light original, and a twin copied across
unchanged.

## What may not hold a colour

**Nothing outside the palette.** `webcheck.theme.ts` fails a hex or colour function
in any `.ts`/`.tsx` under `src/` (`legal/` aside, which is prose as data) and any
utility naming a colour the palette does not — which is exactly what keeps the dark
palette one block rather than a sweep of call sites.

Three traps, each a defect in the dark before it was a rule:

- **`fg` is never a scrim.** It turns light in the dark palette, so `fg` at a
  quarter becomes a white wash. Every scrim is `bg-scrim`.
- **A shadow's colour cannot be themed through `--shadow-*`.** Tailwind v4 copies
  the colour into each utility at build time, so a restated `--shadow-lg` reaches
  nothing. Every shadow layer is `rgb(var(--shade) / calc(α * var(--shade-k)))`;
  the dark block changes those two properties.
- **Translucent text on a solid fill loses contrast faster in the dark.** Half of
  `ink` over `fg` was 4.98:1 in light and 3.30:1 in dark. Measure the dark side of
  any `text-*/NN` on `bg-fg` before choosing the number.

⚠ **The dark block is unlayered on purpose.** `--shade`, `--shade-k` and
`color-scheme` live in a plain `:root` block, and a layered override loses to an
unlayered rule whatever its specificity. The `--color-*` tokens it also restates are
Tailwind's, in `@layer theme`, which it beats either way.

## Which palette is on

`data-theme` on `<html>`, always `light` or `dark`, and **light unless the switch
has stored dark** — the system's appearance is read nowhere, on the owner's word
(Q3.670), and `webcheck` asserts `prefers-color-scheme` and `matchMedia` absent from
all three files. It has exactly two writers, held to one key:

- **`public/theme.js`**, a blocking classic script in the app shell's head, so a dark
  page is dark on its first paint. Classic because a module may run after it; a file
  because the CSP refuses an inline script. It rewrites the `color-scheme` and
  `theme-color` tags, both of which the HTML declares light.
- **`theme.ts`**, which owns every change after: the switch, another webview's
  `storage` event, and telling the shell (`native.ts`'s `setNativeTheme`).

**The gate carries none of it.** It is another origin with no switch, so it is
light, and `webcheck` asserts `gate.html` loads no `theme.js` and `gate-main.tsx`
installs nothing.

**The shell's window is always in the switch's theme** (Q3.671): on macOS a window's
theme is the app's appearance, which the title bar and WKWebView's
`prefers-color-scheme` follow, so a window left to the system would put the system
back in the page.

**A swap turns transitions off for two frames** (`data-theme-swap`), or every
`.tap` fades on its own clock and the palette smears across the screen. Anything
whose motion *is* the answer to the press opts out with `data-keeps-motion` — today
that is the switch's knob and nothing else.

## The switch

The drawer's last list row, **Dark theme**, above the parted-off Sign out; a rule
parts it from plugin screens when there are any. It is `role="switch"` with
`aria-checked`, it leaves the drawer open, and it is the drawer's only row that is
not a destination (Q3.670 amends Q3.612's test).

- **Light until it is pressed**; a press stores the other palette in
  `reemoat.theme`.
- **The choice is the device's.** Every account's webview shares one store, so the
  choice is shared, and signing out keeps it — which is why nothing in `src/` may
  call `localStorage.clear()`.
- **The knob is the only `bg-fg` in the row**, a glyph-sized mark (Q3.209); the track
  takes `raised` when on, the tone this app gives state.
