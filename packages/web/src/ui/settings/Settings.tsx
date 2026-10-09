import type { ReactNode } from "react";
import {
  DEFAULT_SECTION,
  refusedSectionText,
  sectionAllowed,
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
import { EmailSection, SmtpScreen, TestMailScreen } from "./EmailSection";
import { DevicesSection } from "./DevicesSection";
import { KeysSection, NewKeyScreen } from "./KeysSection";
import { LogsSection } from "./LogsSection";
import { MachineAgentsSection } from "./MachineAgentsSection";
import { MachineDevicesSection } from "./MachineDevicesSection";
import { MachinePluginsList, PluginInstallScreen } from "./MachinePluginsSection";
import { MachineSystemsList, MachineSystemsSection } from "./MachineSystemsSection";
import { MachineNameScreen, MachineSection, SetupCodeScreen } from "./MachineSection";
import { MachinesSection } from "./MachinesSection";
import { SettingsNav } from "./SettingsNav";
import { DomainsScreen, MachineLimitScreen, ProvisioningKeyScreen, ServerSection } from "./ServerSection";
import { RoutingKeyScreen } from "./SystemsPanel";
import { NewUserScreen, UserLimitScreen, UsersSection } from "./UsersSection";

export function Settings({ state, route }: { state: AppState; route: SettingsRoute }): ReactNode {
  const section = route.section;
  // A refused or hidden section falls back to the index; only a refused admin section says so.
  const refusal = refusedSectionText(section, state.me);
  const active = section !== null && sectionAllowed(section, state.me, state.host?.canHostDaemon === true) ? section : null;

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
          ) : here.leaf !== null ? (
            <LeafScreen state={state} route={here} />
          ) : drilled && route.machineId !== null ? (
            route.agents ? (
              <MachineAgentsSection state={state} machineId={route.machineId} harness={route.signin} />
            ) : route.list === "systems" ? (
              <MachineSystemsList state={state} machineId={route.machineId} />
            ) : route.list === "plugins" ? (
              <MachinePluginsList state={state} machineId={route.machineId} />
            ) : route.list === "devices" ? (
              <MachineDevicesSection state={state} machineId={route.machineId} />
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

/** Every form and one-time secret is a screen of its own (Q3.549); a new leaf is a compile error until it is drawn here. */
function LeafScreen({ state, route }: { state: AppState; route: SettingsRoute }): ReactNode {
  const machine = route.machineId;
  switch (route.leaf) {
    case null:
      return null;
    case "password":
      return <PasswordScreen me={state.me} />;
    case "email":
      return <EmailScreen me={state.me} config={state.config} />;
    case "new-key":
      return <NewKeyScreen />;
    case "machine-name":
      return machine === null ? null : <MachineNameScreen state={state} machineId={machine} />;
    case "setup-code":
      return machine === null ? null : <SetupCodeScreen machineId={machine} />;
    case "plugin-install":
      return machine === null ? null : <PluginInstallScreen state={state} machineId={machine} />;
    case "routing-key":
      return machine === null || route.system === null ? null : (
        <RoutingKeyScreen key={`${machine}:${route.system}`} machineId={machine} systemId={route.system} />
      );
    case "domains":
      return <DomainsScreen />;
    case "machine-limit":
      return <MachineLimitScreen />;
    case "provisioning-key":
      return <ProvisioningKeyScreen />;
    case "smtp":
      return <SmtpScreen />;
    case "test-mail":
      return <TestMailScreen />;
    case "new-user":
      return <NewUserScreen config={state.config} />;
    case "user-limit":
      return typeof route.userId === "string" ? <UserLimitScreen userId={route.userId} /> : null;
    default:
      return unsectioned(route.leaf);
  }
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

/** The never parameter is what makes a new SettingsSection or SettingsLeaf member a compile error. */
function unsectioned(section: never): ReactNode {
  void section;
  return null;
}
