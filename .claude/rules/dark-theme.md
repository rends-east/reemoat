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

**No component knows which palette is on.** Both are the same twenty-six `--color-*`
tokens: light in `index.css`'s `@theme` block, dark in the unlayered
`:root[data-theme="dark"]` block after it. A component writes `bg-surface`. Q3.669, Q3.670.

## What a token owes in both

A dark value keeps its twin's **job** and **ratio to `surface`**; `webcheck.theme.ts`
computes all of it in both palettes from one table:

- every text tone (`fg`, `muted`, `faint`, `danger`, `caution`, `code`, `link`, the five
  `syn-*` inks, Q3.693) clears 4.5:1 on every paper (`ink`, `surface`, `raised`);
- `chip` sits between `surface` and `raised`, with `code` and `fg` readable on it; the three
  are spent in one file each, which the driver holds (Q3.691);
- `bubble`, a person's message, sits there too with `fg` readable on it, spent in
  `Bubble.tsx` alone (Q3.706);
- `edge-strong`, a control's only boundary, clears 3:1 on every paper;
- `raised` stays 1.22:1 from `surface` (Q3.205), `edge` beyond it, `ink` the rail's 1.06:1
  hint (Q3.210);
- the diff's inks read on their bands, and `fg` on both;
- `on-brand` reads on `brand`, at rest and hovered (Q3.694); `ink` reads on `fg`.

In the dark **elevation reads lighter** (`ink` < `surface` < `raised` < `edge`) and neither
end is pure black or white; both asserted. **A new colour token owes a dark twin in the same
change**: the driver fails a light token with no twin, a dark one with no original, and a
twin copied unchanged.

## What may not hold a colour

**Nothing outside the palette**: `webcheck.theme.ts` fails a hex or colour function in any
`.ts`/`.tsx` under `src/` (`legal/` aside) and any utility naming a colour the palette lacks.

- **`fg` is never a scrim**; it turns light in the dark. Every scrim is `bg-scrim`.
- **A shadow's colour cannot be themed through `--shadow-*`** (Tailwind v4 copies it into
  each utility at build time). Every shadow layer is
  `rgb(var(--shade) / calc(α * var(--shade-k)))`; the dark block changes those two.
- **Translucent text on a solid fill loses contrast faster in the dark**: measure the dark
  side of any `text-*/NN` on `bg-fg` before choosing the number.

**The dark block is unlayered on purpose**: `--shade`, `--shade-k` and `color-scheme` live in
a plain `:root` block, and a layered override loses to an unlayered rule. It beats
Tailwind's `--color-*` in `@layer theme` either way.

## Which palette is on

`data-theme` on `<html>`, always `light` or `dark`, **light unless the switch stored dark**.
The system's appearance is read nowhere (the owner's word, Q3.670); `webcheck` asserts
`prefers-color-scheme` and `matchMedia` absent from all three files. Two writers, one key:

- **`public/theme.js`**, a blocking classic script in the app shell's head, so dark is dark
  on first paint (classic, as a module may run after; a file, as the CSP refuses inline). It
  rewrites the `color-scheme` and `theme-color` tags the HTML declares light.
- **`theme.ts`**, every change after: the switch, another webview's `storage` event, and the
  shell (`native.ts`'s `setNativeTheme`).

**The gate carries none of it** and is light: `webcheck` asserts `gate.html` loads no
`theme.js` and `gate-main.tsx` installs nothing. **The shell's window is always in the
switch's theme** (Q3.671), since on macOS WKWebView's `prefers-color-scheme` follows it.

**A swap turns transitions off for two frames** (`data-theme-swap`), or every `.tap` fades
on its own clock. Motion that answers the press opts out with `data-keeps-motion`: today only
the switch's knob.

## The switch

The drawer's last list row, **Dark theme**, above the parted-off Sign out, parted from
plugin screens by a rule when there are any. `role="switch"` with `aria-checked`; it leaves
the drawer open and is its only row that is not a destination (Q3.670 amends Q3.612).

- **Light until pressed**; a press stores the other palette in `reemoat.theme`.
- **The choice is the device's**: every account's webview shares one store and signing out
  keeps it, so nothing in `src/` may call `localStorage.clear()`.
- **The knob is the row's only `bg-brand`**, a glyph-sized mark (Q3.209); the track takes
  `raised` when on.
