import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { ManifestPreview } from "../pluginArchive";
import { Icon } from "./bits";
import { PLUGIN_SCOPE_TEXT } from "../wire";

/**
 * What a plugin says about itself, drawn before anything is installed.
 *
 * ⚠ **One copy, used by both ways in, and it must stay one.** Two screens ask
 * somebody to agree to the same thing — the file picker in Settings, and the
 * market's expanded plugin view — and they arrive at it differently: one has read
 * an archive in this browser, the other has read `plugin.json` from
 * `raw.githubusercontent.com` at the commit the catalogue pinned. What they show
 * has to be the same sentence, in the same order, with the same fall-through for
 * a scope nobody here has heard of. A second copy is one rewording away from the
 * two paths disclosing the same capability differently.
 *
 * ⚠ **This is the consent step, and it is the whole reason the manifest is read
 * in the browser.** `SECURITY.md` says a plugin's blast radius is "named before
 * somebody consents to it"; it was not. The old flow POSTed the file straight
 * from the picker, and the daemon unpacked it, wrote the row and *started the
 * plugin* before a single scope reached a person — who then read the scopes on
 * the row of something already running. This screen is the sentence that claim
 * needs to be true.
 *
 * `hooks` is drawn beside the scopes rather than under "contributes", because it
 * is disclosure rather than decoration: a plugin that declares only hooks asks for
 * no scopes at all and still gets sent every session's title, agent, workspace and
 * every permission an agent raises. Listing it under contributions would put the
 * most surprising thing on the screen in the least surprising place.
 */
export function PluginConsent({
  manifest,
  names = true,
}: {
  manifest: ManifestPreview;
  /**
   * Whether this block names the plugin it is about.
   *
   * ⚠ **`false` where the screen already did.** The file picker has no other copy
   * of the name — the archive was chosen from a filesystem and nothing on screen
   * says what it is until this reads it — so there it is the *only* identification
   * and must stay. The market's entry page opens with the name, the version and
   * the description as its own heading, and drawing them again three lines down
   * made one card read as two objects about two different plugins.
   *
   * A flag rather than two components, because what must not diverge is
   * everything *below* the heading: the order of the disclosures, and the
   * fall-through for a scope this build has not heard of.
   */
  names?: boolean;
}): ReactNode {
  const rows: { title: string; items: string[] }[] = [
    {
      title: "It may",
      // Read through `Record<string, string>` deliberately: the table is exhaustive
      // over `PluginScope` so that adding a scope is a compile error, but what
      // arrives here is whatever a manifest wrote. A scope this client has not
      // heard of falls through to its raw identifier — an undisclosed capability
      // is the one thing this screen exists to prevent.
      items: manifest.scopes.map((scope) => (PLUGIN_SCOPE_TEXT as Record<string, string>)[scope] ?? scope),
    },
    {
      title: "It is told when",
      items: manifest.hooks.map(
        (hook) =>
          ({
            "session.created": "a session starts",
            "turn.ended": "a turn ends",
            "session.ended": "a session ends",
            "permission.requested": "an agent asks permission",
            "permission.resolved": "a permission is answered",
            // A hook this client has not heard of falls through to its identifier
            // rather than being dropped: an undisclosed hook is the one thing this
            // screen exists to prevent.
          })[hook] ?? hook,
      ),
    },
    { title: "It reaches", items: manifest.net },
    {
      title: "It adds",
      items: [
        ...(manifest.screen === null ? [] : [`a screen, ${manifest.screen}`]),
        ...(manifest.settings ? ["settings of its own"] : []),
        ...manifest.actions.map((action) =>
          // Where it appears, in two words. The title is the plugin's and can be
          // any length, so it goes first and the room it leaves is the surface —
          // a row here wraps rather than truncating, and a wrapped row is what
          // this whole card was cut down to stop.
          action.on === "session" ? `"${action.title}" — session menu` : `"${action.title}" — its screen`,
        ),
      ],
    },
  ];

  const shown = rows.filter((row) => row.items.length > 0);
  const asksNothing = manifest.scopes.length === 0 && manifest.hooks.length === 0;

  return (
    /*
     * ⚠ **The card is drawn only where this block is the identification.**
     *
     * The file picker has no other copy of the name — an archive was chosen off a
     * filesystem and nothing on screen says what it is until this reads it — so
     * there the border and the padding are what make one object out of a name, a
     * version, a description and a fold, and they stay.
     *
     * The market's entry page already opened with all three, and there the card was
     * 24px of padding and a line around a single 44px row reading `Permissions`,
     * sitting between the plugin's own description and the machines it goes on. A
     * box drawn around one collapsed control reads as a region with something in
     * it; what is in it is one word. Bare, it is a disclosure in the flow of the
     * page — which is what it is, and what `Earlier versions` two sections down
     * already looks like.
     *
     * ⚠ **The fold keeps `min-h-11`.** What was spent here is the chrome, never the
     * target: this is the control that opens a list of capabilities somebody is
     * about to grant a stranger's code, on a phone.
     */
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
      <Disclosure first={!names}>
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
        {asksNothing && <p className="text-xs text-muted">It asks for nothing and is told nothing.</p>}
        {/*
         * ⚠ **Inside the fold now, and last, so it is the sentence the list ends
         * on.** It stood outside on the argument that a person who never opens the
         * permissions still has to meet it — and what that produced was a card
         * whose closed state was a collapsed row with a paragraph hanging under it,
         * which reads as a caption for a control rather than as a caveat about a
         * list nobody has opened yet. It is the *conclusion* of the list above it,
         * and outside the fold it was a conclusion to nothing.
         *
         * What is lost is real and small: somebody who never opens this does not
         * read it. What is left in its place is the rule this whole subsystem is
         * built on and states everywhere else — `SECURITY.md`, `docs/PLUGINS.md`,
         * the machine's own plugins screen — that a plugin runs as you. This card
         * is where the *specific* claim is made, and the specific claim is behind
         * one tap along with the sentence that qualifies it.
         */}
        <p className="mt-2.5 text-2xs text-muted">
          A plugin runs on this machine as you, with your files. This is what it declared, not a limit on it.
        </p>
      </Disclosure>
    </div>
  );
}

/**
 * What both pickers accept, spelled once.
 *
 * ⚠ **The two `<input type="file">` elements stay at their call sites and this
 * string does not.** What a picker *does* with the file it is handed is the one
 * thing genuinely different between them — one screen reads the archive and moves
 * to a confirming phase, the other clears a flag first — while the list of
 * extensions is a fact about the daemon's reader and is the same on both. The
 * halves that must not drift are the words and this string; the handler is not
 * one of them.
 */
export const PLUGIN_ARCHIVE_ACCEPT = ".tgz,.gz,.zip,application/gzip,application/zip";

/**
 * What a plugin archive is, above the control that takes one.
 *
 * ⚠ **One copy, for {@link PluginConsent}'s reason one function up.** Two screens
 * ask for the same file and said the same two sentences, typed out twice — and by
 * the time this was lifted the copies had already drifted in their line wrapping,
 * which is how a paragraph starts diverging in what it *says*. There is nothing
 * per-screen in either sentence: both are about what the daemon's reader takes and
 * about the consent step below.
 */
export function PluginArchiveNote(): ReactNode {
  return (
    <>
      <p className="text-xs text-muted">
        A <code className="text-muted/80">.tar.gz</code> or <code className="text-muted/80">.zip</code> holding{" "}
        <code className="text-muted/80">plugin.json</code> and <code className="text-muted/80">server.js</code>.
        Installing the same id again updates it and keeps what it has stored.
      </p>
      <p className="mt-1 text-xs text-muted">Nothing is sent until you have read what it asks for.</p>
    </>
  );
}

/**
 * An archive this browser could not describe, and what that costs.
 *
 * ⚠ **This is the same consent sentence as {@link PluginConsent} in its failed
 * state, so it obeys the same rule and for the same reason: one copy.** It was two
 * — the file picker in Settings and the fleet-wide import — and the header above
 * argues that a second copy of a consent sentence is one rewording away from the
 * two paths disclosing the same capability differently. That is not a prediction
 * any more: the copies had already come apart on the one word that matters here,
 * and only one of them was right about which machines were being spoken for.
 *
 * ⚠ **Not a refusal.** The daemon is what decides whether an archive is a plugin,
 * and it accepts shapes this reader may not — so refusing here would make the
 * browser a second, stricter gate that turns away plugins the machine would have
 * taken. What it may not do is pretend: the whole point of this screen is that
 * somebody knows what they are agreeing to, so when it cannot say, it says that,
 * and the way through is a separate press that names what is being given up.
 */
export function PluginUnreadable({
  reason,
  checker,
  children,
}: {
  /** What the reader could not do, in its own words. */
  reason: string;
  /**
   * Who will still check it properly.
   *
   * ⚠ **The one word that legitimately differs between the two ways in, which is
   * why it is a prop rather than a shared literal.** The picker in a machine's
   * settings sends to that one host; the import screen sends the same bytes to
   * every ticked machine, each of which parses the archive itself. A union rather
   * than a `string`, so a third spelling of the same fact is a compile error.
   */
  checker: "This machine" | "Each machine";
  /**
   * The named press, where the screen that draws it puts it inside this card.
   *
   * ⚠ **Optional because the two screens place it differently and both placements
   * are deliberate.** The fleet-wide import puts it in here, beside the sentence
   * it is buying past, because from there one press reaches every ticked machine.
   * The machine's own picker keeps it in the button row below, where it sits
   * beside the "Choose another file" that is the safe way out of the same state.
   */
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm text-fg">This file cannot be read here</p>
      <p className="mt-1 text-xs text-muted">
        {reason}. Nothing has been sent. {checker} will still check it properly — but until it does, nobody can tell you
        what this plugin asks for.
      </p>
      {children}
    </div>
  );
}

/**
 * The permissions, folded.
 *
 * ⚠ **The closed line says "Permissions" and nothing else, and the permissions
 * themselves are behind it.** It carried a summary of them — `read sessions,
 * control sessions, store d…` — on the argument that names on the closed line
 * are what make agreeing-without-expanding still agreeing to something. That
 * argument was answered by what it produced: the line truncated mid-word in the
 * width it actually has, so the closed state disclosed two capabilities out of
 * four and hid the rest behind an ellipsis, while the control's own label had to
 * share the row with them. A truncated permission list is worse than no list,
 * because it looks complete.
 *
 * What makes closing this acceptable is now the *fold* rather than a summary: it
 * is one tap, it is the first control in the card, and what is inside is six
 * short lines rather than the six sentences that used to be there.
 * `SECURITY.md`'s claim — that a plugin's blast radius is named before somebody
 * consents — is kept by the list being complete and one tap away, and by the
 * sentence below the fold that no plugin can move.
 *
 * A `<button>` rather than `<details>` for `MachineInstalls`' reason — the state
 * has to survive a re-render this screen drives itself — and the same grid
 * animation, so a fold in this app opens one way.
 */
function Disclosure({ first, children }: { first: boolean; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={first ? "" : "mt-2"}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="tap flex min-h-11 w-full items-center gap-1.5 text-left text-xs text-muted hover:text-fg"
      >
        <Icon
          as={ChevronRight}
          size={13}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-fg">Permissions</span>
      </button>
      <div
        id={id}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
