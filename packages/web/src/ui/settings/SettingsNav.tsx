import type { ReactNode } from "react";
import { navigate } from "../../router";
import { GROUP_TITLES, navRows, settingsPath, type SettingsSection } from "../../settings";
import type { AppState } from "../../store";
import { RailRow, SETTINGS_HEADING } from "../bits";

/** The settings section list, mounted as the `sm` rail and as the page body so order and labels cannot drift. */
export function SettingsNav({
  state,
  active,
  paneName,
  variant,
}: {
  state: AppState;
  active: SettingsSection | null;
  /** The pane's own title from the caller's `settingsPaneTitle`; `active` cannot see drill-down depth. */
  paneName: string | null;
  variant: "rail" | "page";
}): ReactNode {
  // `navRows`, so a non-admin never gets a group heading over no rows.
  const rows = navRows(state.me);

  return (
    <nav aria-label="Settings" className="py-1">
      <ul>
        {rows.map(({ spec, heading }) => (
          // `aria-current` rides the item because `RailRow` forwards no attributes.
          <li
            key={spec.id}
            aria-current={variant === "rail" && spec.id === active ? "page" : undefined}
          >
            {heading !== null && (
              // Inside the item it precedes, since a `ul` may hold only `li`.
              <h2 className={`px-4 pt-4 pb-1 ${SETTINGS_HEADING}`}>{GROUP_TITLES[heading]}</h2>
            )}
            <RailRow
              title={spec.title}
              blurb={spec.blurb ?? undefined}
              active={variant === "rail" && spec.id === active}
              onClick={() => navigate(settingsPath(spec.id))}
            />
          </li>
        ))}
      </ul>
      {variant === "rail" && (
        // Announces the pane a rail tap swapped in; mounted with the pop-up so only its text changes.
        <p role="status" aria-live="polite" className="sr-only">
          {paneName}
        </p>
      )}
    </nav>
  );
}
