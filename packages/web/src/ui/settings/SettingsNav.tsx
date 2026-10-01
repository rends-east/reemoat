import type { ReactNode } from "react";
import { CircleUser, Globe, KeyRound, Mail, MonitorSmartphone, ScrollText, Server, Users } from "lucide-react";
import { navigate } from "../../router";
import { GROUP_TITLES, navRows, settingsPath, type SettingsSection } from "../../settings";
import type { AppState } from "../../store";
import { Icon, RailRow, SETTINGS_HEADING } from "../bits";
import { Group, LinkRow } from "../kit/List";

/** A glyph per section in place of a blurb: the rows are scanned, and a sentence under each was read by nobody. */
const SECTION_ICON: Record<SettingsSection, typeof Server> = {
  account: CircleUser,
  devices: MonitorSmartphone,
  keys: KeyRound,
  machines: Server,
  logs: ScrollText,
  server: Globe,
  email: Mail,
  users: Users,
};

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
  // `navRows`, so a non-admin never gets a group heading over no rows; Logs only where the shell can run a daemon.
  const rows = navRows(state.me, state.host?.canHostDaemon === true);

  if (variant === "page") {
    // Below sm the list is the page: one group per heading, each row a way deeper.
    const groups: { heading: string | undefined; rows: (typeof rows)[number][] }[] = [];
    for (const row of rows) {
      if (row.heading !== null || groups.length === 0) groups.push({ heading: row.heading === null ? undefined : GROUP_TITLES[row.heading], rows: [] });
      groups[groups.length - 1]?.rows.push(row);
    }
    return (
      <nav aria-label="Settings" className="px-4 py-4">
        {groups.map((group) => (
          <Group key={group.heading ?? "settings"} title={group.heading}>
            {group.rows.map(({ spec }) => (
              <LinkRow
                key={spec.id}
                glyph={<Icon as={SECTION_ICON[spec.id]} size={16} className="text-muted" />}
                title={spec.title}
                onClick={() => navigate(settingsPath(spec.id))}
              />
            ))}
          </Group>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Settings" className="px-2 py-1">
      <ul className="space-y-0.5">
        {rows.map(({ spec, heading }) => (
          // `aria-current` rides the item because `RailRow` forwards no attributes.
          <li key={spec.id} aria-current={spec.id === active ? "page" : undefined}>
            {heading !== null && (
              // Inside the item it precedes, since a `ul` may hold only `li`.
              <h2 className={`px-3 pt-4 pb-1 ${SETTINGS_HEADING}`}>{GROUP_TITLES[heading]}</h2>
            )}
            <RailRow
              title={spec.title}
              icon={SECTION_ICON[spec.id]}
              active={spec.id === active}
              onClick={() => navigate(settingsPath(spec.id))}
            />
          </li>
        ))}
      </ul>
      {/* Announces the pane a rail tap swapped in; mounted with the pop-up so only its text changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {paneName}
      </p>
    </nav>
  );
}
