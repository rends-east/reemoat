import type { ReactNode } from "react";
import type { ManifestPreview } from "../pluginArchive";
import { Disclosure } from "./bits";
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
  /*
   * ⚠ **Each row says whether it is an *ask*, and that flag is what
   * {@link asksNothing} is derived from.** Three of the four are capabilities the
   * machine grants; the fourth is what this app draws on the plugin's behalf, and
   * conflating them is what produced a card that contradicted itself one line
   * apart. See the sentence below the list.
   */
  const rows: { title: string; items: string[]; asks: boolean }[] = [
    {
      title: "It may",
      asks: true,
      // Read through `Record<string, string>` deliberately: the table is exhaustive
      // over `PluginScope` so that adding a scope is a compile error, but what
      // arrives here is whatever a manifest wrote. A scope this client has not
      // heard of falls through to its raw identifier — an undisclosed capability
      // is the one thing this screen exists to prevent.
      items: manifest.scopes.map((scope) => (PLUGIN_SCOPE_TEXT as Record<string, string>)[scope] ?? scope),
    },
    {
      title: "It is told when",
      asks: true,
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
    { title: "It reaches", asks: true, items: manifest.net },
    {
      /*
       * ⚠ **An *ask*, and the two largest on this card.** A harness is a program
       * this machine will run as its owner on every session started with it; a
       * provider is a host a key pasted on this machine is sent to. The row below
       * — screens, panes, menu rows — is `asks: false` because those are things
       * *this app* draws on the plugin's behalf and nothing is granted. These are
       * the opposite, which is why they are their own row above it rather than two
       * more lines in it.
       *
       * ⚠ **Drawn as the exact strings the daemon compares.** `consentGap` on the
       * far side and `consentBroken` on the way back are set differences over these
       * same lines, so what is read here and what is checked are one value — there
       * is no second rendering of the same fact to drift. That is also why the
       * *whole* address appears rather than an origin: a plugin showing
       * `https://api.groq.com` and shipping `https://api.groq.com/../evil` would
       * pass an origin comparison, and the path is what a key is actually sent to.
       *
       * ⚠ **And the scheme is in the line, which is the whole of the `http`
       * disclosure.** A provider on this machine's own network may be reached over
       * `http` — the daemon refuses it anywhere else — and the honest way to say a
       * key travels in the clear is to show the address it travels to. The sentence
       * below the list qualifies it.
       */
      title: "It adds, to this machine",
      asks: true,
      items: manifest.adds,
    },
    {
      title: "It adds",
      /*
       * ⚠ **The one row that is not an ask.** A screen, a settings pane and a menu
       * row are things *this app* draws for the plugin — nothing is granted, and a
       * plugin whose only entry here is a screen genuinely asks for nothing and is
       * genuinely told nothing.
       */
      asks: false,
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
  /**
   * Whether any provider on this card is reached without TLS.
   *
   * Hoisted rather than inlined into the JSX so that a driver can find it: the one
   * expression that can express this contains `//` inside a string literal, and
   * `webcheck`'s comment stripper eats a line from there on. A named binding is
   * readable on both sides of that.
   *
   * Tested on the *drawn* strings rather than on a parsed field, because those
   * strings are also what the two consent checks compare — so a line that says
   * `http` here is a line that says `http` there.
   *
   * ⚠ **Only the `system ` lines, because a harness line carries an argv and an
   * argv is arbitrary.** `{"command": "acme", "args": ["--base",
   * "http://127.0.0.1:8080"]}` is a perfectly ordinary thing for a CLI to be
   * handed, and over all the lines this drew *"one provider is reached over
   * http"* on a card with no provider on it at all.
   */
  const inTheClear = manifest.adds.some((one) => one.startsWith("system ") && one.includes(" http://"));
  /*
   * ⚠ **`net` was missing from this and the card contradicted itself.** It tested
   * `scopes` and `hooks` only, while the row above it — *It reaches
   * evil.example* — is drawn from `manifest.net`. So a manifest declaring hosts
   * and nothing else rendered the reach row and *"It asks for nothing"* one line
   * apart, on the screen whose entire job is to be believed. Nothing downstream
   * covers it either: `pluginArchive.ts` fails **open** on `net` and does no
   * cross-check against the scopes, unlike the daemon.
   *
   * ⚠ **Derived from the rows rather than from three named fields**, so a fourth
   * ask added above joins this sentence by existing rather than by somebody
   * remembering to come back here — which is exactly what did not happen when
   * `net` was added.
   */
  const asksNothing = rows.every((row) => !row.asks || row.items.length === 0);

  return (
    /*
     * ⚠ **The card is drawn only where this block is the identification.**
     *
     * The file picker has no other copy of the name — an archive was chosen off a
     * filesystem and nothing on screen says what it is until this reads it — so
     * there the border and the padding are what make one object out of a name, a
     * version, a description, the caveat and the list under them, and they stay.
     *
     * The market's entry page already opened with the name, the version and the
     * description as its own heading, so a second box around a second copy of them
     * read as two objects about two different plugins. Bare, this is a disclosure
     * in the flow of the page — which is what it is, and what `Earlier versions`
     * two sections down already looks like, both of them being the same fold now.
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
      {/*
       * ⚠ **Out of the fold, above the list, and drawn on every path — which
       * reverses what this file argued one release ago.** It was the fold's *last
       * child*, on the reasoning that it is the conclusion of the list and outside
       * it was a conclusion to nothing. What that reasoning produced is why it is
       * out: the fold mounted closed, so the **default** render of every install
       * path — the market entry, a machine's own picker, the fleet-wide import —
       * was a collapsed 13px row reading `Permissions`, with live install controls
       * under it and nothing on screen saying what a plugin *is*. On the market
       * entry that collapsed row was the entire consent block. The one sentence
       * naming the blast radius sat behind the same tap as the list it qualifies,
       * and nothing has ever gated Install on that tap being taken.
       *
       * It is not the conclusion of the list, then: it is the frame around it. A
       * plugin runs as you whatever the list says, which is precisely why it has
       * to be readable without opening anything. The list itself opens by default
       * now for the same decision — see `defaultOpen` below.
       *
       * ⚠ **And it is not the quietest thing in the block any more.** It was
       * `text-2xs text-muted`, a step below both the description above it and the
       * capability lines below it — the weight this app gives a footnote, on the
       * one sentence that is true of every plugin whatever its manifest says.
       * `text-xs text-fg` puts it level with the capabilities it is a statement
       * about.
       */}
      <p className={names ? "mt-2 text-xs text-fg" : "text-xs text-fg"}>
        A plugin runs on this machine as you, with your files. This is what it declared, not a limit on it.
      </p>
      {/*
       * ⚠ **One extra sentence, and only where it is about this plugin.** Every
       * other line on this card is drawn for every plugin; this one is drawn when a
       * provider's address is `http`, which the daemon permits only to this machine
       * or this network. It is the one thing in the list a person cannot read off
       * the address unless they already know what `http` means for a pasted key,
       * and it is the difference between a self-hosted model and a key on the wire.
       *
       * Tested on the *drawn* strings rather than on a parsed field, because those
       * strings are the whole of what this component has and are also what the two
       * consent checks compare — so a line that says `http` here is a line that
       * says `http` there.
       */}
      {inTheClear && (
        <p className={names ? "mt-1 text-xs text-fg" : "mt-1 text-xs text-fg"}>
          One provider is reached over http, so a key you save for it is sent unencrypted across that network.
        </p>
      )}
      {/*
       * ⚠ **`defaultOpen` on all three paths: the fold is kept so the list can be
       * put *away*, never so it starts out of sight.** {@link Disclosure} seeds its
       * state once at mount, so this is a default rather than a control — a fold
       * somebody closes stays closed for as long as the screen lives.
       *
       * ⚠ **`first` is `false` unconditionally.** It was `!names`, because on the
       * market path the fold was this block's first child; the caveat above is now
       * always there, so it never is.
       *
       * The 44px target and the grid animation moved to `bits.tsx` with the
       * component: this was the app's only hand-built fold while `MarketEntry`
       * drew a native `<details>` 200px further down the same screen.
       */}
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
        {/*
         * ⚠ **Every ask, including the reach.** The condition is derived from the
         * rows rather than from the two fields it used to name, so this sentence
         * can no longer be drawn under a list of hosts the plugin reaches — see
         * {@link asksNothing}.
         */}
        {asksNothing && (
          <p className="text-xs text-muted">It asks for nothing, is told nothing and reaches nowhere.</p>
        )}
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
 * A doubt about what is on screen, drawn at the weight the decision below it
 * deserves.
 *
 * ⚠ **A shared shell because the *weight* is the property, and stating it twice
 * is how one of them quietly loses it.** Two screens hand somebody an install
 * control while admitting they could not check something: the file picker, which
 * could not read the archive at all, and the market's entry page, whose pinned
 * `plugin.json` did not come back so the permissions below it are the catalogue's
 * unverified summary. The second was a `text-2xs text-muted` paragraph — quieter
 * than the plugin's own description directly above it — beside an ordinary
 * Install button, while the first was this box and a named `DangerButton`. Same
 * doubt, one of them a footnote.
 *
 * The **words** are deliberately not shared, unlike {@link PluginArchiveNote}:
 * the two states are genuinely different — one has no disclosure at all, the
 * other has one it cannot attribute to the pin — and a single sentence covering
 * both would have to be false about one of them. What must not diverge is how
 * loud they are, and that is exactly what lives here.
 *
 * `children` is the way through, where the screen offers one. It is inside the
 * box on purpose: the sentence somebody is buying past should be the thing
 * directly above the press that buys it.
 */
export function ConsentDoubt({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="mt-3 rounded-lg border border-edge p-3">
      <p className="text-sm text-fg">{title}</p>
      {children}
    </div>
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
 * The box is {@link ConsentDoubt}, shared with the market's own unverified-pin
 * card so the two cannot come apart in weight; only the words below are this
 * screen's.
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
    <ConsentDoubt title="This file cannot be read here">
      <p className="mt-1 text-xs text-muted">
        {reason}. Nothing has been sent. {checker} will still check it properly — but until it does, nobody can tell you
        what this plugin asks for.
      </p>
      {children}
    </ConsentDoubt>
  );
}
