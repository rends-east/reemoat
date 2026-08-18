import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../../router";
import { GROUP_TITLES, navRows, settingsPath, type SectionSpec, type SettingsSection } from "../../settings";
import type { AppState } from "../../store";
import { Icon, SETTINGS_HEADING } from "../bits";

/**
 * The list of settings sections, and nothing else.
 *
 * It used to be a rail in the app's own aside, carrying a `Header` with the only
 * way out of settings and a "N waiting" badge. Both are gone, and the badge is the
 * one worth explaining: it was here because at `lg` this component *replaced*
 * `SessionBrowser`, so leaving settings open on a wide screen made every blocked
 * row in the fleet invisible — the one property this whole app is shaped around.
 *
 * Settings is a pop-up now, so the rail is never replaced; it is *covered*, by a
 * scrim on a desktop and by 92dvh of sheet on a phone. The obligation is unchanged
 * and only its reason moved, so the badge moved with it — into `Sheet`, which
 * reads the count itself rather than taking a prop, because a prop is a convention
 * the third caller forgets. `/new/:machineId` gains one it never had as a result.
 *
 * Still one component in two places: the 224px column beside the section at `sm`,
 * and the whole body below it. That is what stops the two drifting into different
 * orders or different labels.
 */
export function SettingsNav({
  state,
  active,
  variant,
}: {
  state: AppState;
  active: SettingsSection | null;
  /** `rail` is the 224px column beside the section at `sm`; `page` is the sheet body below it. */
  variant: "rail" | "page";
}): ReactNode {
  /*
   * `navRows` rather than `visibleSections` plus a `group` read here, and the bug
   * it prevents is invisible to the only people who could report it: a heading
   * computed from the static table draws "Server" above **nothing** for a
   * non-admin, whose visible list has no rows in that group — and only an admin
   * ever sees this nav in a correct state.
   *
   * It also keeps `previous`-row bookkeeping out of JSX, which is the other way
   * a grouped list goes wrong.
   */
  return (
    <div className="py-1">
      {navRows(state.me).map(({ spec, heading }) => (
        <div key={spec.id}>
          {heading !== null && (
            /*
             * The app's one settings-heading typography, at the nav's own `px-4`
             * so heading and rows share a left edge. Deliberately **not**
             * `MENU_HEADING`: that is the same type at `text-faint` with popover
             * padding, and it would sit misaligned against these rows.
             */
            <div className={`px-4 pt-4 pb-1 ${SETTINGS_HEADING}`}>
              {GROUP_TITLES[heading]}
            </div>
          )}
          <SectionRow spec={spec} active={variant === "rail" && spec.id === active} />
        </div>
      ))}
    </div>
  );
}

function SectionRow({ spec, active }: { spec: SectionSpec; active: boolean }): ReactNode {
  return (
    <button
      onClick={() => navigate(settingsPath(spec.id))}
      className={`tap press flex min-h-11 w-full items-center gap-2 px-4 py-3.5 text-left hover:bg-raised ${
        active ? "bg-raised" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{spec.title}</span>
        <span className="block truncate text-xs text-muted">{spec.blurb}</span>
      </span>
      <Icon as={ChevronRight} size={14} className="shrink-0 text-faint" />
    </button>
  );
}
