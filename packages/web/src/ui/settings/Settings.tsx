import type { ReactNode } from "react";
import {
  DEFAULT_SECTION,
  refusedSectionText,
  settingsPaneTitle,
  settingsUp,
  settingsUpLabel,
  type SettingsRoute,
  type SettingsSection,
} from "../../settings";
import type { AppState } from "../../store";
import { ChevronLeft } from "lucide-react";
import { navigate, useOrigin } from "../../router";
import { IconButton } from "../bits";
import { AccountSection, EmailScreen, PasswordScreen } from "./AccountSection";
import { EmailSection } from "./EmailSection";
import { DevicesSection } from "./DevicesSection";
import { KeysSection, NewKeyScreen } from "./KeysSection";
import { LogsSection } from "./LogsSection";
import { MachineAgentsSection } from "./MachineAgentsSection";
import { MachineLinksSection } from "./MachineLinksSection";
import { MachineSystemsSection } from "./MachineSystemsSection";
import { MachineSection } from "./MachineSection";
import { MachinesSection } from "./MachinesSection";
import { SettingsNav } from "./SettingsNav";
import { ServerSection } from "./ServerSection";
import { UsersSection } from "./UsersSection";

export function Settings({ state, route }: { state: AppState; route: SettingsRoute }): ReactNode {
  const section = route.section;
  // A refused section falls back to the index, and the sentence saying so is derived from the same value.
  const refusal = refusedSectionText(section, state.me);
  const active = refusal === null ? section : null;

  const drilled = active === "machines" && route.machineId !== null;
  const here = { ...route, section: active };
  // What the pane draws; the chrome keeps reading active, or a phone gets a chevron to the screen it is on.
  const shown = active ?? DEFAULT_SECTION;
  // The one box that pads, by arm: the phone's index is flush (Q3.553).
  const paneScroll = `min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain no-scrollbar ${
    active === null ? "sm:px-5 sm:py-4" : "px-4 py-4 sm:px-5"
  }`;
  const origin = useOrigin();
  const up = settingsUp(here, origin);
  const paneTitle = settingsPaneTitle(here);
  const upLabel = settingsUpLabel(here, origin);
  // The body's name rather than the highlighted row's, so the rail announces what the pane shows.
  const paneName = settingsPaneTitle({ ...here, section: shown });

  return (
    // The body only: the panel belongs to OverlaySheet, shared by every route-backed pop-up (Q3.484).
    <div className="flex min-h-0 flex-1">
        <div className="hidden w-56 shrink-0 overflow-y-auto overscroll-contain no-scrollbar border-r border-edge sm:block">
          <SettingsNav state={state} active={shown} paneName={paneName} variant="rail" />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {up !== null && (
            <div
              className={`flex shrink-0 items-center gap-2 px-4 pt-4 sm:px-5 ${
                up.withinNav ? "sm:hidden" : ""
              }`}
            >
              {/* Replace, not push: the chevron is always shallower, and a push would make Back walk the sheet. */}
              <IconButton
                icon={ChevronLeft}
                label={`Back to ${upLabel ?? "Settings"}`}
                size="nav"
                className="-ml-1"
                onClick={() => navigate(up.path, true)}
              />
              {paneTitle !== null && <h2 className="min-w-0 text-base font-semibold">{paneTitle}</h2>}
            </div>
          )}
          {refusal !== null && (
            <p className="shrink-0 px-4 pt-4 text-xs text-muted sm:px-5">{refusal}</p>
          )}
          <div className={paneScroll}>
          {active === null ? (
            <>
              <div className="sm:hidden">
                <SettingsNav state={state} active={null} paneName={paneName} variant="page" />
              </div>
              <div className="hidden sm:block">
                <SectionBody state={state} section={DEFAULT_SECTION} />
              </div>
            </>
          ) : route.leaf !== null ? (
            route.leaf === "password" ? (
              <PasswordScreen me={state.me} />
            ) : route.leaf === "email" ? (
              <EmailScreen me={state.me} config={state.config} />
            ) : (
              <NewKeyScreen />
            )
          ) : drilled && route.machineId !== null ? (
            route.agents ? (
              <MachineAgentsSection state={state} machineId={route.machineId} harness={route.signin} />
            ) : route.links ? (
              <MachineLinksSection state={state} machineId={route.machineId} />
            ) : route.system === null && route.signin === null ? (
              <MachineSection state={state} machineId={route.machineId} />
            ) : (
              <MachineSystemsSection
                state={state}
                machineId={route.machineId}
                system={route.system}
                signin={route.signin}
              />
            )
          ) : (
            <SectionBody state={state} section={active} />
          )}
        </div>
      </div>
    </div>
  );
}

function SectionBody({ state, section }: { state: AppState; section: SettingsSection }): ReactNode {
  switch (section) {
    case "machines":
      return <MachinesSection state={state} />;
    case "account":
      return <AccountSection me={state.me} config={state.config} />;
    case "keys":
      return <KeysSection me={state.me} />;
    case "devices":
      return <DevicesSection />;
    case "logs":
      return <LogsSection />;
    case "server":
      return <ServerSection />;
    case "email":
      return <EmailSection />;
    case "users":
      return <UsersSection me={state.me} config={state.config} />;
    default:
      return unsectioned(section);
  }
}

/** The never parameter is what makes a new SettingsSection member a compile error. */
function unsectioned(section: never): ReactNode {
  void section;
  return null;
}
