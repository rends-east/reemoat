import { CircleQuestionMark, LogOut, Puzzle, Settings as SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { MachineId } from "../ids";
import { marketPath } from "../market";
import { pluginPath, screenPlugins } from "../plugins";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { store, type AppState } from "../store";
import { Icon, IconButton, MENU_HEADING, Menu, menuRow } from "./bits";

/**
 * Who you are signed in as, and the three things you can do about it.
 *
 * The sidebar has never carried identity before. `SettingsNav` deleted a "Signed
 * in as…" footer with two arguments — it was the only thing in that column that
 * was not a place to go, and it duplicated the Account screen — and **both
 * dissolve here**, which is why that comment had to be rewritten rather than left
 * standing above its replacement. This row *is* a place to go, and with settings
 * behind a pop-up it is now the only copy of the name anywhere in the chrome; the
 * Account screen still owns the form, so this is a pointer at the single copy
 * rather than a second one.
 *
 * **There is no "Language" row, and no ellipsis of extras.** The reference this
 * was drawn from is Claude's account menu, which has both — this app has no i18n,
 * no help surface beyond the `?` beside this row, and `index.css` explicitly
 * refuses a theme switcher. Said out loud because the next reader will have the
 * same reference open.
 *
 * **Plugins is the third row, and it is here rather than inside Settings for a
 * reason the paragraph above does not cover.** The rule that paragraph is really
 * about is that this menu takes no row which is not *a place to go* — and the
 * plugin market is one, at the same rank as Settings: it is where a plugin is
 * acquired and where you decide which of your machines has it. What it is not is
 * configuration, which is why it did not become a fifth `SECTION_SPEC`. A
 * plugin's own settings, its switch and its screen all stay inside the machine it
 * runs on, where `.claude/rules/plugins.md` argues they belong, and every row in
 * the market links through to them.
 *
 * Growing this menu is still a thing to resist. The test a fourth row has to pass
 * is the one these three pass: it is a destination, it is reached from nowhere
 * else, and it is about *you* rather than about what is on screen.
 */
export function ProfileMenu({
  state,
  machine,
  placement = "up",
  align = "left",
  className = "",
}: {
  state: AppState;
  /** Whose plugin screens to offer. `null` before any machine is selected. */
  machine?: MachineId | null;
  placement?: "up" | "down";
  align?: "left" | "right";
  className?: string;
}): ReactNode {
  const me = state.me;
  const name = me?.name ?? null;
  /*
   * ⚠ **Only the selected machine's, and only the ones that draw a screen and
   * are usable.** A plugin that is switched off or has failed is not offered
   * rather than offered-and-broken: this is a launcher, and a door onto a
   * sentence saying the plugin is not running is worse than no door. That
   * sentence belongs on the plugin's row inside its machine, and is drawn there.
   *
   * Nothing is drawn for a machine with no plugins, and a daemon too old to have
   * the route reads as exactly that — `fetchPlugins` leaves the list empty rather
   * than reporting anything. So this costs nothing to everybody who has never
   * installed one.
   */
  const launchable = machine === undefined || machine === null
    ? []
    : screenPlugins(state.pluginsByMachine.get(machine) ?? []);

  return (
    <Menu
      placement={placement}
      align={align}
      className={className}
      // Bounded to the rail's own width. That is what lets this be `absolute`
      // rather than portaled and measured: it never has to know how much room is
      // to its right, because it never uses any.
      panelClassName="right-0 left-0 w-auto"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`tap flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left hover:bg-raised ${
            open ? "bg-raised" : ""
          }`}
        >
          <Monogram name={name} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {/*
             * `me` is `null` in a state this app really reaches: `bootstrap`'s
             * catch keeps `phase: "ready"` when the control plane is unreachable
             * but machines are already known, and never sets `me`. The row is
             * **never hidden** for it — it is also the way into settings, and an
             * outage is the worst moment for that door to disappear.
             */}
            {name ?? "Signed in"}
          </span>
          {/*
           * **No role badge here, and the menu this opens is where it belongs.**
           *
           * `admin` sat on the row permanently, beside a name that on the
           * single-admin deployment `install.sh` creates *is* "admin" — so the
           * row read `admin  [admin]`. A badge is for an unusual fact about a
           * row among rows; there is one account row in this app and it is
           * yours, so the fact has nobody to be unusual against. What it changes
           * is which settings sections exist, and that is one tap away in the
           * menu, which still names it.
           */}
        </button>
      )}
    >
      {(close) => (
        <>
          <p className={MENU_HEADING}>{name ?? "signed in"}</p>
          {/*
           * The one extra fact worth a line, and only when it is true.
           *
           * Not `me.id` — an opaque `u_…` under a name is noise. `via` earns its
           * place because it changes what this menu can do: `cp.logout` has no
           * session to delete for a key, and clears locally in its `finally`.
           */}
          {me?.via === "api_key" && (
            <p className="px-2.5 pb-1.5 text-2xs text-faint">signed in with an API key</p>
          )}
          {me !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                navigate(settingsPath());
              }}
              className={`${menuRow("center")} text-fg hover:bg-raised`}
            >
              <Icon as={SettingsIcon} size={14} className="text-muted" />
              Settings
            </button>
          )}
          {me !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                navigate(marketPath());
              }}
              className={`${menuRow("center")} text-fg hover:bg-raised`}
            >
              <Icon as={Puzzle} size={14} className="text-muted" />
              Plugins
            </button>
          )}
          {/*
           * The plugin screens this machine offers, under the row that manages
           * them — a heading rather than a separator, because these are not more
           * account actions: they are somebody else's screens, and the word above
           * them is what says so. `MENU_HEADING` is the same type the name at the
           * top of this menu uses, so the menu grows one idiom rather than two.
           */}
          {launchable.length > 0 && machine != null && (
            <>
              <p className={MENU_HEADING}>screens</p>
              {launchable.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    navigate(pluginPath(machine, plugin.id));
                  }}
                  className={`${menuRow("center")} text-fg hover:bg-raised`}
                >
                  <Icon as={Puzzle} size={14} className="text-muted" />
                  {/* The title the plugin chose, falling back to its name — the
                      same pair the launcher drew before it moved here. */}
                  <span className="min-w-0 truncate">{plugin.contributes.screen?.title ?? plugin.name}</span>
                </button>
              ))}
            </>
          )}
          {/*
           * Last, separated, and drawn in the state it is most needed in.
           *
           * With `me === null` this is the *only* row: `AccountSection` already
           * keeps its sign-out outside the `me === null` guard for exactly that
           * reason — the way out must be reachable when the control plane is the
           * thing that is broken.
           *
           * One tap, no two-step confirm. There is none today, and the confirming
           * pattern is a *row* pattern — question, answer, undo, laid out
           * left-to-right — which does not fit a menu this narrow.
           */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              void store.signOut();
            }}
            className={`${menuRow("center")} mt-1 border-t border-edge pt-3 text-danger hover:bg-danger/10`}
          >
            <Icon as={LogOut} size={14} />
            Sign out
          </button>
        </>
      )}
    </Menu>
  );
}

/**
 * A square with a letter in it, rhyming with the logo placeholder above.
 *
 * There is no avatar anywhere on this wire — `Me` is `{id, name, isAdmin, via,
 * hasPassword}` — so this is the only mark available, and making it the same
 * shape and size as the logo is what stops the footer looking like a different
 * application from the header.
 *
 * The first *grapheme*, not the first char: a name starting with an emoji or a
 * combining pair would otherwise render half a character.
 */
function Monogram({ name }: { name: string | null }): ReactNode {
  const letter = name === null ? "" : [...name.trim()][0]?.toUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-raised text-2xs font-semibold text-muted"
    >
      {letter}
    </span>
  );
}

/** The `?` beside the account row. A sibling button, never nested inside it. */
export function HelpButton(): ReactNode {
  return (
    <Menu
      placement="up"
      align="right"
      panelClassName="w-64"
      trigger={(open, toggle) => (
        <IconButton
          icon={CircleQuestionMark}
          label="Help"
          /*
           * ⚠ **`chip`, and this was a hand-rolled `h-9 w-9`** — one more copy
           * of the class string `IconButton` exists to retire. The primitive's
           * docblock counts four and this file is not among the ones it names,
           * which is the point: 36px with no growth mechanism at all is what a
           * copy reproduces, and it is the one size `ICON_BUTTON_SIZE` deleted
           * rather than resized.
           *
           * Not `sm`: this sits `gap-1` — four pixels — from the account row,
           * which is a 44px target running the whole width of the rail. A
           * symmetric `after:-inset-2.5` is ten pixels a side, so six of them
           * would land on that row's *face*, and a thumb aimed here would open
           * the account menu instead. `chip` grows vertically only, and the 4px
           * up plus 8px down lands in the footer's own padding: the New session
           * button is 8px above, and below is the bottom of the rail.
           */
          size="chip"
          /* `expanded`, not `active`: `aria-pressed` is a toggle that stays
             pressed, and this is a control that reveals a region.

             `haspopup` is the other half: what kind of thing opens, against
             `expanded`'s whether it is open. Both were on the hand-rolled button
             this replaced, `haspopup` was briefly dropped in the move, and both
             call sites recorded the loss instead of quietly taking it — which is
             the only reason it was cheap to put back. */
          expanded={open}
          haspopup="menu"
          onClick={toggle}
          /*
           * ⚠ **`bg-raised` alone, where this wrote `bg-raised text-fg`.** The
           * second half was already dead and nobody could see it: Tailwind v4
           * emits utilities alphabetically, so `.text-fg` is printed before the
           * tone's own `.text-muted` and loses to it whichever way the class
           * attribute reads — the `menuRow` defect, one file over. The fill is
           * what this app spends on state in any case.
           */
          className={open ? "bg-raised" : ""}
        />
      )}
    >
      {() => (
        <div className="px-2.5 py-2 text-xs text-muted">
          <p className="font-medium text-fg">Keyboard</p>
          {/*
           * The caveat is the load-bearing half, and it is why the shortcut legend
           * that used to sit under the New session button was deleted rather than
           * moved: it advertised these as a feature, listed an `r` that has never
           * been bound, and said nothing about the fact that none of them fire
           * while a text field has focus — which on this screen is most of the
           * time. A legend that is wrong more often than it is right teaches
           * people to ignore legends.
           */}
          <p className="mt-1.5">
            <kbd>j</kbd> / <kbd>k</kbd> move between sessions, <kbd>/</kbd> jumps to the message box.
          </p>
          <p className="mt-1.5 text-faint">
            None of them fire while you are typing, which is most of the time.
          </p>
        </div>
      )}
    </Menu>
  );
}
