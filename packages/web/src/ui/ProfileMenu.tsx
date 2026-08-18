import { CircleQuestionMark, LogOut, Settings as SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { store, type AppState } from "../store";
import { Icon, MENU_HEADING, MENU_ROW, Menu } from "./bits";

/**
 * Who you are signed in as, and the two things you can do about it.
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
 */
export function ProfileMenu({
  state,
  placement = "up",
  align = "left",
  className = "",
}: {
  state: AppState;
  placement?: "up" | "down";
  align?: "left" | "right";
  className?: string;
}): ReactNode {
  const me = state.me;
  const name = me?.name ?? null;

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
              className={`${MENU_ROW} items-center text-fg hover:bg-raised`}
            >
              <Icon as={SettingsIcon} size={14} className="text-muted" />
              Settings
            </button>
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
            className={`${MENU_ROW} mt-1 items-center border-t border-edge pt-3 text-danger hover:bg-danger/10`}
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
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Help"
          title="Help"
          className={`tap inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg ${
            open ? "bg-raised text-fg" : ""
          }`}
        >
          <Icon as={CircleQuestionMark} size={16} />
        </button>
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
