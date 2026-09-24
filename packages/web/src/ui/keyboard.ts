import { useEffect } from "react";
import { keyOf } from "../ids";
import { isBareKey, isTypingInto } from "../keys";
import { navigate, sessionPath, type Route } from "../router";
import { sessionGroups, type AppState } from "../store";
import { markKeyNav } from "./composing";
import { currentView, visibleRows } from "./groups";
import { currentLayers, shortcutsEnabled } from "./overlay";

/** Bare-letter shortcuts, limited to what is free to undo: `j`/`k` move between sessions, `/` focuses the composer, Escape blurs. */
export function useKeyboard(state: AppState, route: Route): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isBareKey(event)) return;

      // `inert` does not stop a window keydown, so `j`/`k` would walk the list behind a sheet.
      if (!shortcutsEnabled(currentLayers())) return;

      if (event.key === "Escape") {
        const active = document.activeElement;
        if (active !== null && "blur" in active) (active as HTMLElement).blur();
        return;
      }

      if (isTypingInto(event.target)) return;

      if (event.key === "/") {
        event.preventDefault();
        // Found by its accessible label rather than a ref threaded through the shell.
        const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
        composer?.focus();
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "j" && key !== "k") return;

      // The rail's own order, filter, tab and search included, from the same function.
      const groups = sessionGroups(state);
      const rows = visibleRows(groups, currentView(groups));
      if (rows.length === 0) return;

      const currentKey = route.name === "session" ? keyOf(route.ref) : null;
      const index = rows.findIndex((row) => row.key === currentKey);
      const next =
        index === -1
          ? key === "j"
            ? 0
            : rows.length - 1
          : Math.min(Math.max(index + (key === "j" ? 1 : -1), 0), rows.length - 1);

      const target = rows[next];
      if (target !== undefined && target.key !== currentKey) {
        // Tell the composer the hop was the keyboard's, or it takes the caret and the next `j` types a letter.
        markKeyNav();
        navigate(sessionPath(target.ref));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, route]);
}
