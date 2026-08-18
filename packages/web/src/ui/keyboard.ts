import { useEffect } from "react";
import { keyOf } from "../ids";
import { isBareKey, isTypingInto } from "../keys";
import { navigate, sessionPath, type Route } from "../router";
import { sessionGroups, type AppState } from "../store";
import { markKeyNav } from "./composing";
import { currentView, visibleRows } from "./groups";
import { currentLayers, shortcutsEnabled } from "./overlay";

/**
 * The desktop keyboard layer.
 *
 * Only three keys, and the restraint is deliberate. Every shortcut here is a
 * *bare* letter, because that is what makes them worth having on a two-pane
 * screen — and a bare letter is one mistyped keystroke away from every other
 * letter, so the set is limited to things that are free to undo. Moving between
 * sessions is free. Approving a permission and stopping an agent are not, and
 * neither has a shortcut for that reason.
 *
 *   j / k   next / previous session, in the order the list shows them
 *   /       focus the composer
 *   Escape  leave whatever has focus
 *
 * `isTypingInto` is the guard that makes bare letters possible at all: without
 * it, `j` in the composer navigates away mid-sentence.
 *
 * That guard is also why this layer owns **three** facts about focus rather than
 * two. `/` takes the caret and Escape releases it, both plainly; and `j`/`k`
 * decline to hand it over, by telling `composing.ts` the hop was theirs. The
 * composer now focuses itself on a session switch, and without that third fact
 * every `j` after the first would type a letter into a message instead of moving
 * to the next session.
 */
export function useKeyboard(state: AppState, route: Route): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isBareKey(event)) return;

      /*
       * Nothing here fires while a sheet is open, and this guard is not optional.
       *
       * `overlay.ts` puts `inert` on `#root` while one is, which stops taps and
       * focus reaching the app underneath — and does **not** stop a `window`
       * keydown. So without this, `j` and `k` walk the session list *behind* the
       * settings sheet, navigating to sessions nobody can see and changing what
       * the ✕ will reveal. Escape is not exempted either: the arbiter has already
       * claimed it and stopped propagation, so this never runs for it anyway.
       *
       * A menu and an ask card deliberately do not block — see `shortcutsEnabled`.
       */
      if (!shortcutsEnabled(currentLayers())) return;

      if (event.key === "Escape") {
        const active = document.activeElement;
        if (active !== null && "blur" in active) (active as HTMLElement).blur();
        return;
      }

      // `/` while typing is a slash, obviously. Everything below is gated the
      // same way.
      if (isTypingInto(event.target)) return;

      if (event.key === "/") {
        event.preventDefault();
        // Queried by its label rather than held as a ref: the composer is
        // mounted by a different subtree, unmounts with the route, and threading
        // a ref up through the shell for one keystroke is more machinery than
        // the feature is worth. The label is also what a screen reader reads,
        // so it is not a private hook that can silently rot.
        const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        composer?.focus();
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;

      /*
       * The order the rail *actually* renders, not a second flattening that
       * claims to match it.
       *
       * This used to be `[...blocked, ...active, ...ended]` under a comment
       * asserting it was the same order — true by coincidence, and grouping would
       * have broken it silently: `j` would have stepped onto rows inside collapsed
       * sections that nobody could see. `visibleRows` is the single source, so the
       * two cannot disagree.
       *
       * **The filter is part of that order and was being dropped.** This called
       * `visibleRows(groups)`, whose default is `"all"`, while the rail drew
       * `"active"` — so on the default filter `j` walked onto ended rows that were
       * not on screen. The claim above was true about collapse and false about
       * filtering, which is worse than no claim at all.
       *
       * **Three inputs decide that order now** — the filter, which machine's tab
       * is selected, and what has been typed into the search box — so the
       * parameter is a whole `ListView` and has no default at all. `currentView`
       * is the one place module state becomes a view, and the rail calls the same
       * function, which is what keeps a single source from becoming three.
       */
      const groups = sessionGroups(state);
      const rows = visibleRows(groups, currentView(groups));
      if (rows.length === 0) return;

      const currentKey = route.name === "session" ? keyOf(route.ref) : null;
      const index = rows.findIndex((row) => row.key === currentKey);
      // From nowhere, `j` starts at the top and `k` at the bottom — which for a
      // list sorted blocked-first means `j` lands on whatever needs you most.
      const next =
        index === -1
          ? key === "j"
            ? 0
            : rows.length - 1
          : Math.min(Math.max(index + (key === "j" ? 1 : -1), 0), rows.length - 1);

      const target = rows[next];
      if (target !== undefined && target.key !== currentKey) {
        // The composer takes the caret on a session switch (see `composing.ts`),
        // and `isTypingInto` above switches every bare shortcut off once it has
        // it — so without this, `j` worked exactly once and then typed a `j`.
        markKeyNav();
        navigate(sessionPath(target.ref));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, route]);
}
