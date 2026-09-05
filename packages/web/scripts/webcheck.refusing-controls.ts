import { readFileSync } from "node:fs";
import { check } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

process.stdout.write("\nwhat a control still looks like when it refuses\n");
{
  /*
   * ⚠ **Nothing typed can hold a class string**, so these are read off disk the
   * way the plugin-settings placement assertions already are — and the comments
   * come off first, which is the failure this block hit on its first run rather
   * than tidiness. `SystemsPanel`'s own docblock quotes `hover:border-edge-strong`
   * while arguing against it and `bits.tsx`'s quotes both `disabled:opacity-40`
   * and `border-edge` for the same reason, so every negative assertion below is
   * false against the raw file and true against the code.
   */
  const source = (name: string): string =>
    stripComments(readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"));
  const bits = source("ui/bits.tsx");
  const newSession = source("ui/NewSession.tsx");
  const builder = source("ui/AgentBuilder.tsx");
  const systems = source("ui/settings/SystemsPanel.tsx");
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    if (start === -1) return "";
    /*
     * ⚠ **A missing *terminator* is the failure this line exists for.** Without
     * it `indexOf` answers `-1`, `slice(start, -1)` returns the whole rest of the
     * file bar one character, and the found-guard below — which tests `length > 0`
     * — goes green over a slice that has quietly stopped being about anything.
     * Every negative assertion made over it then reports a hit from somewhere else
     * entirely. Measured: renaming the anchor this section ends at swallowed
     * `DirectoryPicker`'s two `disabled:opacity-40` buttons, 300 lines below, and
     * the failure named the agent strip.
     */
    const end = text.indexOf(to, start + from.length);
    return end === -1 ? "" : text.slice(start, end);
  };
  const choiceRow = between(bits, "export function ChoiceRow", "\n}\n");
  const tile = between(newSession, "const bound = disabled", "</button>");
  const strip = between(newSession, "function AgentStrip(", "\nfunction MachineLine");
  const tones = between(bits, "const BUTTON_TONE", "\n};");
  const trigger = between(bits, "tap press inline-flex min-h-8 w-full", '"');
  // `Dropdown`'s option row — the fourth control, and the one this whole section
  // was written about a screen too early. See the sweep below.
  const option = between(bits, 'role="option"', "</button>");
  const iconButton = between(bits, "export function IconButton", "\n}\n");
  // A slice that came back empty is a rename, and every negative assertion below
  // would pass over it while asserting nothing at all — which is the one failure
  // mode a text-matching driver has that a typed one does not.
  check(
    "every control this section is about was actually found",
    [choiceRow, tile, strip, tones, trigger, option, iconButton].map((one) => one.length > 0),
    [true, true, true, true, true, true, true],
  );

  /*
   * ⚠ **No opacity on a control that carries its own refusal, and the number is
   * the whole argument.** `disabled:opacity-40` composites the *entire* control,
   * subline included: over `--color-surface` (#ffffff), `--color-faint` at 40%
   * becomes #C2BFB9 = 1.83:1 and `--color-fg` at 40% is 2.51:1. `index.css` bounds
   * `--color-faint` by measurement at ≥4.5:1 precisely because almost every use of
   * it is 12px — and on both of these controls the 12px subline *is* the refusal.
   * A reason has to be more legible than the label it refuses, never less, and an
   * opacity is the one property that cannot tell the two apart.
   */
  check("no opacity is spent on the row that has to say why it refuses", /opacity/.test(choiceRow), false);
  check("nor on the tile that does", /opacity/.test(tile), false);
  check("nor anywhere else in the strip", /opacity/.test(strip), false);
  /*
   * ⚠ **And on `Dropdown`'s option row, which is where this rule shipped broken
   * one screen over while the three assertions above were green.** The row
   * carried `disabled:opacity-40 disabled:hover:bg-transparent` while rendering
   * `item.description`, and `MachinePicker` in `NewSession.tsx` is a live caller
   * passing `unusableReason(machine)` as that description beside `why !== null`
   * as `disabled` — so an offline or read-only machine drew its **name** at
   * 2.51:1 and the whole of **why it cannot be reached** at 1.83:1 over the
   * panel's own `bg-surface`. This menu is the only place in the app a
   * non-selected machine's reason appears at all.
   */
  check("nor on the dropdown option that carries the same kind of reason", /opacity/.test(option), false);
  check(
    "which dims its label and leaves the reason at full strength",
    [
      /\$\{unavailable \? "text-muted" : ""\}/.test(option),
      /<span className="block text-2xs text-faint">\{item\.description\}/.test(option),
    ],
    [true, true],
  );
  /*
   * ⚠ **Granted by state rather than reclaimed by a variant, and the negative
   * half is what makes the positive one mean anything.** `:hover` still matches a
   * disabled `<button>`, so `disabled:hover:bg-transparent` is two utilities
   * racing in the sheet to undo one another — the trap `FIELD` and `menuRow` both
   * document — where `${unavailable ? "" : "hover:bg-raised"}` never emits the
   * one it does not want. `ChoiceRow` reasons this way already.
   */
  check(
    "and grants its hover fill by state instead of taking it back",
    [/disabled:hover:/.test(option), /unavailable \? "" : "hover:bg-raised"/.test(option)],
    [false, true],
  );
  /*
   * ⚠ **The sweep is over the file now, not over a list of controls, and that
   * change is the actual finding.** Four named slices assert the rule on the four
   * rows it has already been applied to; the row above shipped broken *because*
   * the sweep was written that way, and the next control here to grow a
   * description while carrying `disabled:opacity-40` would ship the same way. So:
   * three sanctioned sites in the whole of `bits.tsx`, and nothing anywhere else.
   *
   * The three share one condition — a control with **no boundary to lose and no
   * subline to composite**. `BUTTON_TONE.primary` is a `bg-fg` fill whose children
   * are a label; `BUTTON_TONE.ghost` is bare text, one line; `IconButton` renders
   * a glyph and nothing else, and its `label` becomes `aria-label` and `title`,
   * neither of which an opacity composites. A fourth appearing anywhere in this
   * file is the defect, and the way this assertion gets "fixed" wrongly is by
   * raising the number.
   */
  check("exactly three sanctioned opacities in the whole vocabulary file", (bits.match(/opacity/g) ?? []).length, 3);
  check(
    "and all three are on controls with no boundary to lose and no subline to composite",
    /opacity/.test(bits.replace(tones, "").replace(iconButton, "")),
    false,
  );
  /*
   * ⚠ **Scoped to the strip and deliberately not to the file.** `DirectoryPicker`'s
   * two ghost text buttons keep theirs, which is `BUTTON_TONE.ghost`'s stated
   * exemption: bare text with no boundary to lose and no subline to composite. A
   * file-wide sweep here would be wrong, and the way it would be "fixed" is by
   * deleting a rule rather than by finding a defect.
   */
  check("while the two ghost buttons below it still have theirs", (newSession.match(/disabled:opacity-40/g) ?? []).length, 2);
  /*
   * The replacement, which is `BUTTON_TONE.plain`'s own pattern: the **title**
   * goes to `text-muted` (7.75:1 on surface), the glyph to `text-faint`, and the
   * subline **stays** at full `text-faint` (6.23:1) with no expression on it at
   * all. That last one is the load-bearing half — it is the only thing on either
   * control saying why it cannot be pressed.
   */
  check(
    "the tile dims its title and its glyph and leaves the reason alone",
    [
      /className=\{disabled \? "text-faint" : "text-muted"\}/.test(tile),
      /\$\{disabled \? "text-muted" : ""\}/.test(tile),
      /className="[^"]*w-full truncate text-2xs text-faint">\s*\{subline\}/.test(tile),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **And that line is *reserved*, which rendering an empty span does not do.**
   * A harness tile has nothing to say on it and a preset always has something, so
   * the two kinds stand in one row with a different number of lines — and the row
   * is `items-stretch` while each tile is `justify-center`, so the shorter content
   * column is centred inside the taller box.
   *
   * Measured against the built stylesheet in headless Chrome: an empty `<span>`
   * generates no line box and is **0px** tall, and the harness tile's glyph and
   * name each landed **9px** below the preset's beside it. The comment claiming an
   * empty string held the slot was wrong, and a zero-height third child buys back
   * only the 4px `gap-1`. After: both tiles 84px, both sublines 18px, both glyphs
   * at 11px and both names at 33px.
   *
   * Keyed to the same custom property `text-2xs` sets its own line-height from, so
   * the reserved height and the text that would fill it cannot drift apart — a
   * hard-coded `1.125rem` here would be the second copy this file exists to catch.
   */
  check(
    "the subline holds its line even when it is empty, at the height its own text would take",
    [
      /min-h-\[var\(--text-2xs--line-height\)\][^"]*">\s*\{subline\}/.test(tile),
      /--text-2xs--line-height: /.test(readFileSync(new URL("../src/index.css", import.meta.url), "utf8")),
    ],
    [true, true],
  );
  check(
    "and the row does the same three, in the same order",
    [
      /disabled \? "text-faint" : "text-muted"/.test(choiceRow),
      /disabled \|\| placeholder \? "text-muted" : ""/.test(choiceRow),
      /className="block truncate text-2xs text-faint">\{subline\}/.test(choiceRow),
    ],
    [true, true, true],
  );

  /* ---------------------------------------------------------------- *
   * A control's boundary is the control
   *
   * `index.css` states it verbatim: `--color-edge` "is a decorative hairline and
   * **may never be the sole identification of a control**", while
   * `--color-edge-strong` is held at ≥3:1 on all three surfaces because WCAG
   * 1.4.11 asks that of a non-text control with no fill — which is most controls
   * in this app by request, since a field or a button is drawn in the colour of
   * the thing it sits on. `SHEET_BODY` is `bg-surface` (#ffffff) and both of these
   * were `border-edge bg-surface`: a white control on a white ground whose only
   * boundary measured 1.31:1.
   * ---------------------------------------------------------------- */
  check("the row's boundary is a boundary", /border border-edge-strong/.test(choiceRow), true);
  check("the tile's is too", /border-edge-strong/.test(tile), true);
  check("and the + beside it, dashed or not", /border-dashed border-edge-strong/.test(strip), true);
  /*
   * ⚠ **And a refused one hands that boundary *back*, which the three assertions
   * above cannot see.** They ask only that the strong edge survived somewhere in
   * the slice, so re-applying the unconditional sweep — the sweep that put
   * `edge-strong` on every state and made two greyed harness rows in `AgentBuilder`
   * indistinguishable from the one pressable row — passes all three again. What
   * has to be pinned is the *ternary*: an inert row takes the decorative hairline
   * and a live one takes the boundary.
   *
   * WCAG 1.4.11 asks 3:1 of "visual information required to identify user
   * interface components and states, **except for inactive components**", so
   * `edge` at 1.31:1 on an inert row is the exempted case rather than a tolerated
   * one — and `edge-strong` there is not merely unneeded but actively false, since
   * the strong edge *is* this app's signal that a thing can be pressed.
   */
  check(
    "and a refused row gives it back for the decorative hairline",
    /disabled \? "border border-edge" : "border border-edge-strong"/.test(choiceRow),
    true,
  );
  /*
   * ⚠ **On the tile the assertion is that `disabled` is asked *first***, which is
   * the whole of what the ladder decides. Asking `picked` first is the exact bug:
   * a restored pick naming a harness the machine no longer has would take the
   * strong border while being unpressable — the state that shipped once, drawn
   * `aria-pressed` and `disabled` at the same time. The fill and the check stay on
   * a picked-and-disabled row, because they say *which one is chosen* and that is
   * still true; only the boundary goes.
   */
  check(
    "and the tile asks whether it is refused before it asks whether it is chosen",
    /const bound = disabled\s*\? "border-edge"\s*: picked\s*\? "border-edge-strong"/.test(tile),
    true,
  );
  /*
   * ⚠ **The order stated once as a property rather than twice as a shape**, so a
   * ladder rewritten in some other syntax still has to answer it: on neither
   * control does `border-edge-strong` appear in an arm guarded by `disabled ?`.
   * That is what the screenshot was about.
   */
  check(
    "and neither hands a pressable-looking edge to something that cannot be pressed",
    [choiceRow, tile].map((one) => /\bdisabled\s*\?\s*"[^"]*edge-strong/.test(one)),
    [false, false],
  );
  /*
   * ⚠ **And the split that keeps `BUTTON_TONE` pointing the other way is a rule
   * rather than an inconsistency**, so the next sweep does not "fix" the buttons to
   * match the rows. A button is a **lone** control — nothing beside it is
   * pressable — so its border answers *is there a control here at all*, which is
   * what the `Add agent` regression measured. A picker row is one of a run of
   * siblings differing only in whether they can be taken, so its border answers
   * *which of these can I press*, and a strong edge on a refused one is false. The
   * second half: a row carries its own refusal as a subline and a button carries
   * none. The assertion for it is the `disabled:border-edge` negative below, which
   * is currently false and must stay false.
   */
  /*
   * ⚠ **`Dropdown`'s option row is the control this fix does not apply to, and
   * that finding is pinned rather than left to be rediscovered.** `menuRow` emits
   * no border in either state — a row inside `MENU_PANEL` is identified by the
   * panel's own box and by 44px of hover fill — so there is no strong edge there
   * making a false claim, and adding one to live rows would be a new decoration
   * rather than an identification. Asserted as an absence so that a future
   * bordered menu row is forced to answer the disabled arm rather than inheriting
   * a strong edge in silence.
   */
  check("while the menu row has no boundary to hand back in either state", /border-edge/.test(option), false);
  /*
   * ⚠ **Hover moves a fill, never a border**, which `index.css` states as the
   * consequence a builder has to apply: the gap is now #E3E1DD → #7B7873, a jump
   * louder than the press itself. So the `hover:bg-raised` half is kept and the
   * `hover:border-edge-strong` half is asserted gone — on the primitive, on the
   * strip, and on the two screens that migrated onto the primitive.
   */
  check(
    "and every one of them takes its hover as a fill",
    [choiceRow, tile, strip].map((one) => /hover:bg-raised/.test(one)),
    [true, true, true],
  );
  check(
    "with no border moved under a pointer anywhere this run touched",
    [choiceRow, tile, strip, builder, systems].map((one) => /hover:border-/.test(one)),
    [false, false, false, false, false],
  );
  /*
   * ⚠ **And `ChoiceRow` is the only row shape on the two screens that migrated.**
   * The string it replaced — `min-h-14 … rounded-lg border … px-3 py-2.5 text-left
   * hover:border-edge-strong` — existed byte-identically in six places, three of
   * which are still typed out (`MachinesSection`, `InstalledList`, `MarketList`)
   * and are named as a known remainder in the primitive's own docblock. This is
   * what stops a seventh being typed on the screens it was extracted from.
   */
  check("and neither migrated screen writes a row of its own", [/min-h-14/.test(builder), /min-h-14/.test(systems)], [false, false]);

  /*
   * The same deletion one layer down, where it was made twice more. `plain` and
   * `destructive` had a `disabled:border-edge` arm, which is the identical 1.31:1
   * hand-back spelled as a token rather than as an opacity, and `Dropdown`'s
   * trigger carried a third copy on a `bg-surface` control sitting on a
   * `bg-surface` sheet.
   *
   * ⚠ **Token-exact, and the negative lookahead is required rather than
   * defensive:** `destructive` deliberately *does* carry
   * `disabled:border-edge-strong` — it gives up its own `border-danger/45`
   * (2.27:1, never the identification either) along with its label — so a plain
   * `includes("disabled:border-edge")` fails it, and the way that gets "fixed" is
   * by deleting the boundary a third time.
   *
   * ⚠ **That figure read 2.11:1 in this comment and in `BUTTON_TONE`'s own
   * docblock, in both places, and it was simply wrong** — nobody had re-run it
   * since it was written down, and a comment asserts nothing, so nothing ever
   * would have. The arithmetic is below rather than in prose now, because the
   * argument the paragraph makes rests on the number being under 3:1 and a
   * measurement that only two comments agree on is a measurement that agrees with
   * itself. Nothing is reversed by the correction: 2.27 is still well under the
   * 3:1 WCAG 1.4.11 asks of a non-text control with no fill, so `border-danger/45`
   * was never the identification either — which is exactly why `destructive`
   * hands it back for `edge-strong`.
   */
  check("neither outlined tone hands its boundary back when it is refused", /disabled:border-edge(?!-strong)/.test(tones), false);
  /*
   * The measurement itself, off `index.css`'s own tokens rather than off either
   * comment. `/45` is Tailwind's colour alpha, so the swatch is `--color-danger`
   * composited over the ground it sits on — `--color-surface`, since a
   * `destructive` button is drawn on a sheet — and the ground is what a border
   * with no fill behind it is read against.
   */
  const cssTokens = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const token = (name: string): [number, number, number] => {
    const hex = new RegExp(`--color-${name}: #([0-9a-f]{6});`).exec(cssTokens)?.[1] ?? "";
    return [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((pair) => parseInt(pair, 16)) as [number, number, number];
  };
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (front: [number, number, number], back: [number, number, number], alpha: number): [number, number, number] =>
    front.map((value, index) => Math.round(alpha * value + (1 - alpha) * back[index]!)) as [number, number, number];
  const ratio = (one: number, other: number): number =>
    (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
  const surface = token("surface");
  const dangerEdge = over(token("danger"), surface, 0.45);
  check("the danger border at 45% is the swatch the docblock names", `#${dangerEdge.map((value) => value.toString(16).padStart(2, "0")).join("")}`, "#c5a5a0");
  check(
    "and it measures 2.27:1 on surface, which is under 3:1 and is the whole argument",
    [ratio(luminance(dangerEdge), luminance(surface)).toFixed(2), ratio(luminance(dangerEdge), luminance(surface)) < 3],
    ["2.27", true],
  );
  /*
   * ⚠ **And the docblock says the number this driver just computed.** Read from
   * the *raw* file on purpose: the figure lives in prose, which `stripComments`
   * removes, and a positive assertion about prose is exactly what the stripping
   * rule permits — the hazard it guards against is a negative assertion satisfied
   * by a comment quoting the thing it argues against. This is the pin that would
   * have caught 2.11 the day it was written.
   */
  const bitsRaw = readFileSync(new URL("../src/ui/bits.tsx", import.meta.url), "utf8");
  check(
    "and BUTTON_TONE's own docblock quotes it rather than remembering it",
    bitsRaw.slice(bitsRaw.indexOf("border-danger/45"), bitsRaw.indexOf("const BUTTON_TONE")).includes("2.27:1"),
    true,
  );
  check(
    "and the two tones that keep the opacity are the two with no boundary to lose",
    [/primary: "[^"]*disabled:opacity-40/.test(tones), /ghost: "[^"]*disabled:opacity-40/.test(tones)],
    [true, true],
  );
  check(
    "the dropdown's trigger dims its ink and keeps its box",
    [/border border-edge-strong/.test(trigger), /disabled:text-faint/.test(trigger), /disabled:border-edge(?!-strong)/.test(trigger)],
    [true, true, false],
  );
}

process.stdout.write("\nno authorization on the Configure agent screen\n");
{
  /*
   * ⚠ **The rule is that a thing is *not here*, and nothing typed can hold
   * that.** A routed pairing — one harness pointed at another vendor's endpoint,
   * Claude Code answering from Moonshot — is signed by a pasted key and nothing
   * else, and for a release the builder mounted the settings screen's own
   * `KeyOnly` box inline under the chosen pair so the key could be typed where it
   * was needed. Nobody signed in there. The box is gone, and what replaces it is
   * a standing rule: the screen whose whole subject is which model runs under
   * which harness takes no credential, and there is no authorization on it at
   * all. A rule of that shape is a placement, so it is read off disk — the way the
   * plugin-settings and import-flow assertions already are.
   *
   * ⚠ **Read from the *raw* file, which inverts this driver's usual rule and does
   * so deliberately.** Everywhere else the comments come off first, because a
   * negative assertion is otherwise satisfied by a docblock quoting the thing it
   * argues against. Here the negative *is* the subject: the file's prose was
   * written to name neither identifier, precisely so the absence could be total.
   * A comment reintroducing `KeyOnly` fails this check, and that is the correct
   * outcome for a file whose rule is that the box is not on it.
   */
  const builderRaw = readFileSync(new URL("../src/ui/AgentBuilder.tsx", import.meta.url), "utf8");
  const builder = stripComments(builderRaw);
  const systemsRaw = readFileSync(new URL("../src/ui/settings/SystemsPanel.tsx", import.meta.url), "utf8");
  const systems = stripComments(systemsRaw);
  // The usual guard: a file that came back empty is a rename, and every negative
  // assertion below would pass over it while asserting nothing at all.
  check("the screen and the panel it no longer borrows from were both found", [builder.length > 0, systems.length > 0], [true, true]);

  check(
    "the builder names no credential control, in its code or in its prose",
    [/KeyOnly/, /keyMissing/, /\.\/settings\//].filter((one) => one.test(builderRaw)).map(String),
    [],
  );
  /*
   * ⚠ **Every field on the screen, swept rather than sampled.** Naming the
   * removed component catches the box coming back by the door it left through;
   * this catches it arriving by any other, including a credential field typed out
   * by hand with no import at all. The screen is entitled to exactly three inputs —
   * the agent's name, the shared search box and a typed model id — and each is
   * identified by an attribute rather than by position, so reordering the file is
   * not a failure and a fourth field is.
   */
  const fields = builder.split("<input").slice(1).map((one) => one.slice(0, 500));
  /*
   * Three now, and the third is a *model id* — typed under a routable provider's
   * group, substituted into the listing, and never a secret: it is the string a
   * routed session names in `ANTHROPIC_MODEL`, which is on the wire in clear
   * anyway. It is identified by its label, which names the system it belongs to.
   */
  check("and carries exactly three fields", fields.length, 3);
  // Written as "none is unaccounted for" rather than "three are accounted for":
  // the second form is satisfied by a fourth field arriving beside the known
  // ones, and leans entirely on the count above to notice.
  check(
    "and every one of them is one of the three it is entitled to",
    fields.filter(
      (one) =>
        !/aria-label="Agent name"/.test(one) &&
        !/type="search"/.test(one) &&
        !/aria-label=\{`Type a \$\{system\.displayName\} model id`\}/.test(one),
    ).length,
    0,
  );
  /*
   * ⚠ **And none of them is dressed as a credential**, which needs its own list
   * because `type="password"` is not how this app writes one. `KeyOnly`'s field is
   * `type="text"` on purpose — Chrome's password manager keys on the input type
   * and ignores `autocomplete="off"` on it by design, so it offered to fill an
   * account password into the Z.ai key box — and what actually marks it are the
   * opt-outs it carries instead. Those are the strings to watch for, together with
   * one pattern covering both client methods that put a key on the wire.
   */
  check(
    "nor dressed as one by any of the marks this app's real key field carries",
    [/type="password"/, /autoComplete/, /data-1p-ignore/, /data-lpignore/, /SystemKey\(/].filter((one) => one.test(builder)).map(String),
    [],
  );
  /*
   * ⚠ **The complement, in the same check so the pair cannot drift.** Removing one
   * call site has to be provably a different act from deleting the component: the
   * key is still pasted, under Settings → Machines → the system, and the box is
   * still mounted twice there — once for a system reached natively and once,
   * `routing={true}`, for one that is only ever routed at. A future tidy-up that
   * deleted the component because "nothing mounts it" would take the only door in
   * with it.
   */
  check(
    "while the box itself still exists, and is still mounted twice in settings",
    [
      /export function KeyOnly\(/.test(systemsRaw),
      (systems.match(/<KeyOnly\b/g) ?? []).length,
      /<KeyOnly[^>]*routing=\{true\}/.test(systems),
    ],
    [true, 2, true],
  );
  /*
   * ⚠ **The two-step confirmation on that same panel, which had a *sentence* and no
   * geometry.** `web-shell.md` states the rule and states why it is a safety
   * property rather than a preference: the first tap replaces the row's controls
   * with the question and its two answers, both groups lay out in the **same box**
   * so the last child occupies the same pixels, `setConfirming(true)` is
   * synchronous, and `.tap` removes the double-tap delay — so a second tap aimed at
   * a control that looked inert lands on Cancel rather than on the irreversible
   * half. One class string rendered in both branches is what makes "the same
   * pixels" true; two strings that happen to match are the same screen until
   * somebody tunes one of them.
   *
   * ⚠ **`align="center"`, and it is pinned because `justify-end` is the value that
   * was tried and reverted on the identical control one file over.** `AgentsPanel`'s
   * `SignOutButton` shipped trailing-aligned on exactly the geometric argument a
   * reader would restate — and what it drew was a Sign out button pinned to the
   * right of an empty box. Centring replaced it with the ordering rule intact, and
   * this panel's docblock names that as the shape it took. The box is `TwoStep`'s
   * now (E7's review, Q3.552) — one element in both arms, Cancel last its
   * guarantee — so what this file holds is that the removal reaches the primitive
   * centred, with a destructive act and the named button as its `rest`, and
   * that no `justify-*` of this panel's own is written beside it.
   */
  {
    const asks = systems.indexOf("Remove the {keyName}? New sessions pointed at");
    const start = asks < 0 ? -1 : systems.lastIndexOf("<TwoStep", asks);
    // Positional, and the anchors are the element's own opening and its `/>`: a
    // regex over the tag cannot be used here, because `onClick={() => …}` puts a
    // `>` inside the props that `[^>]*` stops at — the trap the plugin-surface
    // sweep tracks brace depth to avoid.
    const asking = start < 0 ? "" : systems.slice(start, asks + systems.slice(asks).search(/^\s*\/>/m));
    const keyOnly = systems.slice(systems.indexOf("export function KeyOnly("));
    check("the removal is the primitive's, and the question was found", [start >= 0, asks >= 0], [true, true]);
    check(
      "one box in both arms, centred rather than trailing, with the named button at rest",
      [
        /align="center"/.test(asking),
        /\bjustify-(?:center|end)\b/.test(keyOnly),
        /act=\{\{ label: "Remove", danger: true, icon: Trash2 \}\}/.test(asking),
        /rest=\{[\s\S]*?<DangerButton icon=\{Trash2\} disabled=\{busy\} onClick=\{\(\) => setConfirmingRemove\(true\)\}>\s*Remove the \{keyName\}/.test(asking),
        /setConfirmingRemove\(false\)/.test(keyOnly),
      ],
      [true, false, true, true, false],
    );
    /*
     * **One lock, both ways** (E7's review). The act is refused while a save
     * is out — `disabled` on the box's `busy` — and the key form's Save reads
     * the same flag, so it is refused while a removal is out only if `remove`
     * sets it. Handed to the primitive as a bare promise the lock read one way:
     * Remove, then Enter in the form before the daemon answered, and a set and
     * a remove of the same credential were in flight together.
     */
    const removal = keyOnly.slice(keyOnly.indexOf("const remove = "), keyOnly.indexOf("const borrowed = "));
    check(
      "and the removal holds the box's busy, so the key form is refused while it is out",
      [
        /disabled=\{busy \|\| daemon === undefined\}/.test(asking),
        /^const remove = \(\): Promise<void> \| undefined => \{\s*if \(daemon === undefined\) return undefined;\s*setBusy\(true\);\s*return daemon\s*\.removeSystemKey\(system\.id\)/.test(removal),
        /onChanged\(\);\s*\}\)\s*\.finally\(\(\) => setBusy\(false\)\);\s*\};/.test(removal),
      ],
      [true, true, true],
    );
  }
  /*
   * ⚠ **The gate is unchanged, and this is the half a source assertion can carry.**
   * Removing the box removed a *remedy*, never a refusal: `choiceRefusal` still
   * folds `keyMissing` in, so a keyless routed pairing that reaches this screen
   * anyway still disables `Add agent` and still says why beside it. Both pickers
   * grey that pair as of this run, so what reaches the button now is a pair no
   * picker chose: **editing a saved preset**, which seeds the harness and the model
   * straight from `GET /custom-agents`, or a key revoked on another device since
   * this screen read `GET /systems`. The gate guards the write, not just the row.
   * The behavioural half is the section below, where
   * `choiceRefusal` is driven; this is the wiring, which no type can hold.
   */
  check(
    "the one button on the screen is still wired to the refusal that folds the key in",
    [
      // ⚠ **`nameOf` is part of the wiring now, not decoration.** `choiceRefusal`
      // names the harness, and `agentLabel` — its default — answers a raw id for a
      // harness a plugin added. Dropping the argument would put `acme:gemini` into
      // the one sentence that stands between somebody and a Save they cannot undo.
      /const conflict = current === null \? null : choiceRefusal\(harness, current, routingOf\(harness\), nameOf\);/.test(
        builder,
      ),
      /disabled=\{busy \|\| current === null \|\| harness === null \|\| conflict !== null\}/.test(builder),
    ],
    [true, true],
  );
  /*
   * And the line beside it draws that same value, so the button and the sentence
   * cannot disagree about which pair is refused.
   *
   * ⚠ **It carries news or nothing, and the second half is asserted too.** The
   * slot used to fall through to a nudge — "pick a model", "pick a harness" —
   * which restated at 12px what the two rows above say at 14 with a chevron each,
   * on the one screen where the missing half is the most visible thing on it.
   * Reported as a caption that says nothing. What may appear here is a refusal or
   * a failure, both of which are unreadable from the rows; a prompt to do the
   * obvious is not, and the empty arm is what keeps it out.
   *
   * The span itself stays mounted unconditionally either way — a `role="status"`
   * inserted in the same paint as its content is commonly not announced at all,
   * which is the arrangement `Sheet`'s own region records.
   */
  check(
    "and the line beside it is that same refusal, with nothing to say when there is none",
    [
      /role="status"[^>]*>\s*\{error \?\? conflict\}/.test(builder.replace(/\s+/g, " ")),
      /pick a (model|harness|LLM)/i.test(builder),
    ],
    [true, false],
  );

  /*
   * ⚠ **The other consumer of that refusal, which this block claimed to cover and
   * did not.** The comment above says it pins "the wiring", and it pinned the
   * button alone — while the model list makes its own call and feeds its own
   * `subline` and `disabled` from it. A mutation run reintroduced the reported bug
   * through exactly that gap: one added clause on the list's call site left
   * Moonshot's table-spelled row pressable while Z.ai's identically-keyless row
   * greyed, one screen apart, with `agents.ts` untouched and every assertion about
   * it still green. A rule the screen is free to discard is not held.
   *
   * The fourth element is the load-bearing one and is the cheapest guard there is.
   * `nativeHarness` is the exact field the deleted arm consulted; `keyMissing`'s
   * docblock now says it is not consulted at all, and this screen has no
   * legitimate use for it — so its **absence** is assertable, in the same negative
   * style this file already applies to the credential control, and it fails on any
   * re-introduction of the asymmetry by that door.
   */
  const builderFlat = builder.replace(/\s+/g, " ");
  check(
    "and every row of the model list is greyed by that same refusal, unconditioned",
    [
      /const why = choiceRefusal\(null, choice, null\);/.test(builder),
      /subline=\{ shared !== null \? null : \(why \?\? \(groups\.length > 1 \? null : group\.system\.displayName\)\) \}/.test(
        builderFlat,
      ),
      /disabled=\{why !== null\}/.test(builder),
      /nativeHarness/.test(builder),
    ],
    [true, true, true, false],
  );
  /*
   * ⚠ **A pairing *is* refused on this screen now — on the provider, never on the
   * row — and the difference between those two is why the older rule could stand
   * for three releases and this can replace it.** Q3.479 refused to weigh the
   * harness here at all, because greying both screens against each other leaves
   * neither half of a bad pair changeable. Two things answer that: each field can
   * be emptied on the screen above (pinned in the stacked-pair section), and the
   * refusal lands on a **heading** rather than on 463 rows.
   *
   * The arithmetic is the argument, so it is driven rather than described — see
   * the `agents.ts` section. Here: the group question is `hostable`'s, with
   * `hostable`'s own sentence, and it may never be `choiceRefusal`'s, whose prose
   * deliberately drops the system's name because it is wrong over a row.
   */
  check(
    "a provider the harness cannot be pointed at is one heading, asked of hostable and no one else",
    [
      /const wholeProvider = harness === null \? null : hostable\(harness, group\.system, routing, nameOf\);/.test(
        builder,
      ),
      /if \(wholeProvider !== null\)/.test(builder),
      // With no harness answered it may not fire, so the flow's own order — the
      // model first — reaches exactly the screen it always did.
      /harness === null \? null :/.test(builder),
    ],
    [true, true, true],
  );
  /*
   * ⚠ **The hoist is the same call, and that is the whole of why it is allowed.**
   * A subline identical on every row of a large group is drawn once under the
   * heading — otherwise OpenRouter's 356 keyless rows are one sentence repeated
   * 356 times. It would be a hole in the rule above if the hoisted sentence came
   * from anywhere else, so its own call site is pinned to `choiceRefusal(null, …)`
   * too, and the group is required to be *unanimous* before one row's answer is
   * allowed to stand for the rest.
   */
  check(
    "and the sentence hoisted off a large group is that same refusal, unanimous",
    [
      /const sublines = group\.choices\.map\(\(one\) => choiceRefusal\(null, one, null\)\);/.test(builder),
      /sublines\.every\(\(one\) => one === first\)/.test(builder),
      /group\.choices\.length > 3/.test(builder),
    ],
    [true, true, true],
  );

  /*
   * ⚠ **The reserved glyph slot, which is what makes the two stacked rows share a
   * left edge — and which no assertion watched, so deleting it was invisible.**
   * The harness row draws its mark conditionally, and drew it *only* when
   * answered: choosing a harness moved that row's own text 28px to the right —
   * 18px of glyph plus the row's `gap-2.5` — leaving the Model row's label and the
   * Harness row's label on two different left edges for good. `ChoiceRow` reserves
   * its check slot against exactly this. The slot is reserved for the **pair**
   * rather than per row, so both `glyph` props are asserted together.
   */
  const stacked = builder.replace(/\s+/g, " ");
  const pair = stacked.slice(stacked.indexOf('<Field label="Harness"'), stacked.indexOf("</Field> </div>"));
  check("the stacked pair was found and both rows ask for a glyph", [pair.length > 0, (pair.match(/glyph=/g) ?? []).length], [true, 2]);
  /*
   * ⚠ **Harness first, and the order is the assertion.** Asked for by name: *"swap
   * the harness and the agent on the agent configuration screen, so the agents
   * finish loading while the harness is being chosen."* The model row is the one
   * control here that waits — `GET /agents/capabilities` starts an agent per
   * harness, 2159 ms measured after Q3.524 — and on top it was the first thing
   * anybody met, a row reading *Reading models…* that could not be opened. The
   * harness list is `AGENT_IDS` and needs no read at all.
   *
   * Pinned rather than left to the file, because an order is exactly the kind of
   * thing a later edit restores without noticing: this is two sibling JSX blocks
   * and nothing in the types, the props or the router says which comes first. It
   * is also the order the model list is *built* for — with a harness chosen,
   * `ModelPicker` collapses every provider it cannot be pointed at — so the two
   * halves of this screen's refusal story now arrive in the order they explain.
   * Q3.528.
   */
  check(
    "the row that costs nothing to answer is above the row that waits",
    stacked.indexOf('<Field label="Harness"') < stacked.indexOf('<Field label="Model"'),
    true,
  );
  /*
   * `[^<]*` between the two tags rather than nothing: `Field` takes a second prop
   * now and its value carries a `>` of its own, from an arrow. What the anchor has
   * to keep is that no other **element** sits between the field and its row, which
   * is what a bare `>` could not say and this can.
   */
  check(
    "the row that can never have one reserves the hole, and the row that can fills it",
    [
      /<Field label="Model"[^<]*> <ChoiceRow glyph=\{emptyGlyph\}/.test(pair),
      /<Field label="Harness"[^<]*> <ChoiceRow glyph=\{harness === null \? emptyGlyph : <AgentGlyph agent=\{harness\} size=\{18\} \/>\}/.test(pair),
    ],
    [true, true],
  );
  /*
   * ⚠ **Both fields can be emptied, and each empties only itself.** A pairing is
   * refused on both screens now — the model list collapses a provider the chosen
   * harness cannot be pointed at — and that is only safe because a bad pair can be
   * taken apart a field at a time. Q3.479 rejected the *implicit* form of this
   * twice, a disabled row that clears the other choice when tapped; a labelled
   * control on the row whose value it empties deletes nothing unasked.
   *
   * The second element is the load-bearing one: one press may never empty two
   * fields, or it is implicit again for whichever field the reader did not aim at.
   */
  check(
    "each field can be emptied, and a clear reaches no further than its own",
    [
      (pair.match(/clear=\{/g) ?? []).length,
      /clear=\{current === null \|\| busy \? null : \(\) => setPicked\(null\)\}/.test(pair),
      /clear=\{harness === null \|\| busy \? null : \(\) => setHarness\(null\)\}/.test(pair),
      /setPicked\(null\)[^}]*setHarness/.test(pair),
      /setHarness\(null\)[^}]*setPicked/.test(pair),
    ],
    [2, true, true, false, false],
  );
  /*
   * ⚠ **And the refusal is on the row it is about**, which is the harness row —
   * every sentence `choiceRefusal` can produce here names the harness or the
   * system, and the model row's one line is spent on which provider the model came
   * from. It is *also* still at the foot, which the check above pins: this slot is
   * `truncate` and that one is `wrap-anywhere`, and Q3.497 required both.
   */
  check(
    "the pair's refusal is drawn on the harness row, and the model row still names its provider",
    [
      /<Field label="Harness"[^<]*>.*?subline=\{conflict\}/.test(pair),
      /subline=\{reading \? [^:]*: \(current\?\.system\.displayName \?\? null\)\}/.test(pair),
    ],
    [true, true],
  );
  /*
   * ⚠ **And the one arm in front of it is the pending one, which is the whole of
   * what this screen still waits for.** `GET /agents/capabilities` starts an agent
   * per harness — 5.3 seconds measured — and used to hold the entire screen behind
   * a spinner although only this row needs it. The row says what it is waiting for
   * and cannot be opened while it waits; nothing else on the screen can lie in the
   * meantime, because with no model chosen `harnessRowRefusal` answers `null` for
   * every row and Save is already disabled on `current === null`.
   */
  check(
    "and the model row is the only thing that waits for the expensive read",
    [
      /disabled=\{busy \|\| reading\}/.test(pair),
      /const reading = capabilities === null;/.test(builder),
      // The gate the screen is drawn behind names the cheap read and not this one.
      /if \(systems === null \|\| \(preset !== null && stored === null\)\) \{/.test(builder),
      // …and the sub-screen that has nothing to list draws a spinner rather than
      // an empty picker, since it is reachable by address as well as by a tap.
      /if \(step === "llm" && reading\) \{/.test(builder),
    ],
    [true, true, true, true],
  );
  /*
   * ⚠ **And the two widths are asserted as equal rather than as two literals**,
   * because equality is the property: a hole one pixel off the mark it stands in
   * for is the same misalignment in miniature, and two `18`s typed out separately
   * agree only until one of them is changed.
   */
  const slot = /const emptyGlyph = <span aria-hidden="true" className="block h-\[(\d+)px\] w-\[(\d+)px\]" \/>;/.exec(builder);
  const mark = /<AgentGlyph agent=\{harness\} size=\{(\d+)\}/.exec(stacked);
  check("and the hole is square and exactly as wide as the mark it holds a place for", [slot?.[1], slot?.[2], mark?.[1]], ["18", "18", "18"]);

  /*
   * ⚠ **`AgentGlyph`'s `never` arm is the only mechanism in this fleet that makes
   * adding a harness *loud*, and widening `AgentId` to a string would have deleted
   * it in silence.** A `switch` over a string has no exhaustiveness to check, so
   * the arm would have gone on compiling while meaning nothing — which is exactly
   * the failure this function shipped for four releases with a docblock claiming
   * the opposite. What preserves it is the narrowing: the `switch` runs inside
   * `isBuiltinAgentId`, where `never` is still `never`.
   *
   * ⚠ **And the other branch takes no second prop**, which is not a style rule.
   * Two contributed harnesses drawn as one generic mark are two identical tiles on
   * a strip whose titles `truncate` at 96px — the row would say nothing about which
   * is which, which is what the four distinct shapes exist to prevent. A monogram
   * derived from `agent` alone is what makes them distinct without a `label` prop,
   * and without one the two pinned `<AgentGlyph …>` call sites above stay exactly
   * as they are.
   */
  {
    const icons = readFileSync(new URL("../src/ui/AgentIcons.tsx", import.meta.url), "utf8");
    check(
      "a harness a plugin added is drawn, and the never arm that makes a fifth built-in loud is still reachable",
      [
        /if \(!isBuiltinAgentId\(agent\)\) return <MonogramGlyph agent=\{agent\} size=\{size\} \/>;\s*switch \(agent\) \{/.test(icons),
        /function unglyphed\(agent: never\)/.test(icons),
        // Derived from the id, so the element keeps its two props.
        /function MonogramGlyph\(\{ agent, size \}: \{ agent: string; size: number \}\)/.test(icons),
        /agent\.slice\(agent\.indexOf\(":"\) \+ 1\)/.test(icons),
      ],
      [true, true, true, true],
    );
    // And it is a letter rather than nothing: a blank shape is the state this
    // branch exists to avoid, and an empty `<text>` is indistinguishable from one.
    check("and what it draws is a letter", /\{letter\}/.test(icons) && /\(Array\.from\(local\)\[0\] \?\? "\?"\)\.toUpperCase\(\)/.test(icons), true);
  }
}
