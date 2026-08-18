/**
 * What a link in agent output is allowed to be.
 *
 * A pure module for one rule, for the reason `agentConfig.ts` is one: `webcheck`
 * has no DOM, so a rule living in a JSX prop is untested by construction — and
 * this one decides where a tap goes on a page whose `localStorage` holds
 * `reemoat.credential`.
 *
 * `links.ts` and not `markdown.ts`, which is the obvious name: this filesystem is
 * case-insensitive, so a module beside `Markdown.tsx` differing only in case is a
 * `TS1149` and the two files cannot coexist.
 */

/**
 * The schemes a tap may open, and why the list is this short.
 *
 * `http`/`https` are the only ones that mean anything from a phone looking at a
 * relayed session, and `mailto` is the one non-web scheme that opens something
 * every device already has. Everything else — `file:`, `vscode:`, `ssh:`, a
 * scheme somebody's OS has a handler for — is *"launching a program named by an
 * agent-chosen string"*, which is the same sentence, and the same answer, as the
 * refusal of `url`-mode elicitation.
 */
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/**
 * The href to put on an anchor, or `null` to draw the text without one.
 *
 * **Relative links are the case this exists for, and react-markdown lets them
 * through on purpose.** Its `defaultUrlTransform` blocks dangerous protocols —
 * `javascript:` never reaches here, which is why this is not an XSS fix — but its
 * first condition is "if there is no protocol, it's relative", and relative is
 * returned untouched. That is right for a document rendered next to the files it
 * links, and wrong here: this page is served by the *control plane*, so an agent
 * writing `[about_me.txt](about_me.txt)` produces a link to
 * `https://<control-plane>/about_me.txt`, which the SPA fallback answers with
 * `index.html`. Tapping a filename opened a second copy of the app.
 *
 * The path in that link is real, but it is a path on the machine the *agent* is
 * on, and this origin has no relationship to it. A file under the workspace is
 * reachable — `GET /sessions/:id/files` and the download buttons that use it — and
 * that route goes through the daemon with a header, never an `href` a browser
 * follows. So the honest rendering of a path is text, not a link somewhere else.
 *
 * `null` rather than a stripped `href=""`, which navigates to the current page.
 *
 * Absolute URLs are parsed rather than string-matched: `new URL` is what decides
 * what the browser would actually do with `HtTps:` or a scheme with padding, and
 * a hand-rolled prefix test is how a scheme check acquires a hole.
 */
export function openableHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    // No base, so anything relative throws — which is the branch that matters.
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return OPENABLE.has(parsed.protocol) ? trimmed : null;
}
