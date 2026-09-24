import type { ReactNode } from "react";
import type { ManifestPreview } from "../pluginArchive";
import { Disclosure } from "./bits";
import { PLUGIN_SCOPE_TEXT, type PluginHook } from "../wire";

const PLUGIN_HOOK_TEXT: Record<PluginHook, string> = {
  "session.created": "a session starts",
  "turn.ended": "a turn ends",
  "session.ended": "a session ends",
  "permission.requested": "an agent asks permission",
  "permission.resolved": "a permission is answered",
};

// Object.hasOwn, since a manifest key like __proto__ must not be answered by Object.prototype; an unknown key falls through to itself.
function said(table: Record<string, string>, key: string): string {
  return Object.hasOwn(table, key) ? (table[key] ?? key) : key;
}

/** The one consent disclosure, shared by the file picker and the market so the two paths cannot word a capability differently. */
export function PluginConsent({
  manifest,
  names = true,
}: {
  manifest: ManifestPreview;
  names?: boolean;
}): ReactNode {
  const rows: { title: string; items: string[]; asks: boolean }[] = [
    {
      title: "It may",
      asks: true,
      items: manifest.scopes.map((scope) => said(PLUGIN_SCOPE_TEXT as Record<string, string>, scope)),
    },
    {
      title: "It is told when",
      asks: true,
      items: manifest.hooks.map((hook) => said(PLUGIN_HOOK_TEXT as Record<string, string>, hook)),
    },
    { title: "It reaches", asks: true, items: manifest.net },
    {
      // Drawn as the exact strings the daemon's consent checks compare, whole address and scheme included.
      title: "It adds, to this machine",
      asks: true,
      items: manifest.adds,
    },
    {
      title: "It adds",
      asks: false,
      items: [
        ...(manifest.screen === null ? [] : [`a screen, ${manifest.screen}`]),
        ...(manifest.settings ? ["settings of its own"] : []),
        ...manifest.actions.map((action) =>
          action.on === "session" ? `"${action.title}" — session menu` : `"${action.title}" — its screen`,
        ),
      ],
    },
  ];

  const shown = rows.filter((row) => row.items.length > 0);
  // Hoisted so webcheck can find it; system lines only, since a harness line carries an arbitrary argv.
  const inTheClear = manifest.adds.some((one) => one.startsWith("system ") && one.includes(" http://"));
  // Derived from the rows, so a new ask joins this sentence without being named.
  const asksNothing = rows.every((row) => !row.asks || row.items.length === 0);

  return (
    <div className={names ? "mt-3 rounded-lg border border-edge p-3" : "mt-3"}>
      {names && (
        <>
          <p className="text-sm text-fg">
            {manifest.name || manifest.id || "This plugin"}{" "}
            <span className="text-muted">{manifest.version}</span>
          </p>
          {manifest.description !== null && <p className="mt-0.5 text-xs text-muted">{manifest.description}</p>}
        </>
      )}
      <p className={names ? "mt-2 text-xs text-fg" : "text-xs text-fg"}>
        A plugin runs on this machine as you, with your files. This is what it declared, not a limit on it.
      </p>
      {inTheClear && (
        <p className="mt-1 text-xs text-fg">
          One provider uses http; its saved key travels unencrypted.
        </p>
      )}
      {/* defaultOpen: the fold may be put away, never start out of sight. */}
      <Disclosure first={false} label="Permissions" defaultOpen>
        {shown.map((row) => (
          <div key={row.title} className="mt-2.5 first:mt-0">
            <p className="text-xs text-muted">{row.title}</p>
            <ul className="mt-1 space-y-0.5">
              {row.items.map((item, index) => (
                <li key={`${row.title}-${index}`} className="text-xs text-fg">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {asksNothing && (
          <p className="text-xs text-muted">It asks for nothing, is told nothing and reaches nowhere.</p>
        )}
      </Disclosure>
    </div>
  );
}

export const PLUGIN_ARCHIVE_ACCEPT = ".tgz,.gz,.zip,application/gzip,application/zip";

export function PluginArchiveNote(): ReactNode {
  return (
    <p className="text-xs text-muted">
      <code className="text-muted/80">.tar.gz</code> or <code className="text-muted/80">.zip</code> with{" "}
      <code className="text-muted/80">plugin.json</code> and <code className="text-muted/80">server.js</code>.
      Re-installing keeps stored data.
    </p>
  );
}

/** One shell so every consent doubt keeps the same weight; the words stay per screen. */
export function ConsentDoubt({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm text-fg">{title}</p>
      {children}
    </div>
  );
}

/** Not a refusal: the daemon decides what a plugin is, so this only says the browser could not read it. */
export function PluginUnreadable({
  reason,
  checker,
  children,
}: {
  reason: string;
  checker: "This machine" | "Each machine";
  children?: ReactNode;
}): ReactNode {
  return (
    <ConsentDoubt title="This file cannot be read here">
      <p className="mt-1 text-xs text-muted">
        {reason}. Nothing has been sent. {checker} will still check it properly — but until it does, nobody can tell you
        what this plugin asks for.
      </p>
      {children}
    </ConsentDoubt>
  );
}
