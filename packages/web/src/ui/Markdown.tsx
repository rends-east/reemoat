import { Check, Copy, Download, Loader } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { filenameFor } from "../paths";
import { Icon, LINK } from "./bits";
import { copyText } from "./clipboard";
import { useFileAccess } from "./files";
import { openableHref } from "./links";

/**
 * Agent output, rendered as what it is.
 *
 * Everything an agent writes is markdown — it is trained to write markdown and
 * every other client renders it as such — and this app displayed it as
 * `<p className="whitespace-pre-wrap">`. Headings arrived as `###`, tables as
 * pipes, and a code block as three backticks and an unstyled wall.
 *
 * Three constraints shape what is here.
 *
 * **This runs on a streaming string.** `EventList` coalesces consecutive text
 * events into runs, and a run in flight routinely ends mid-fence, mid-table or
 * mid-word. So the component is memoised on the joined text and nothing waits
 * for the run to be "complete": an unterminated ``` renders as a code block that
 * grows, which is the right degradation and needs no special case.
 *
 * **The highlighter is loaded on demand.** `highlight.js` with its language set
 * is far larger than everything else in this bundle put together, and the first
 * paint on a phone is the thing this app is judged on. Until it arrives, code is
 * plain — which is what it was before, so nothing regresses while it loads.
 *
 * **No `rehype-raw`.** Agent output is untrusted text from a model that is
 * quoting a repository, and enabling raw HTML here would render whatever either
 * of them produced. `react-markdown` escapes HTML by default; that default is
 * the security boundary and must stay.
 */

/** Registered lazily, once, on the first code block that names a language. */
let highlighter: Promise<typeof import("highlight.js/lib/core").default> | null = null;

const LANGUAGES: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  css: () => import("highlight.js/lib/languages/css"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
};

/** Aliases an agent actually writes, mapped onto the registered names. */
const ALIAS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  md: "markdown",
  patch: "diff",
};

function resolveLanguage(name: string): string | null {
  const lower = name.toLowerCase();
  const resolved = ALIAS[lower] ?? lower;
  return resolved in LANGUAGES ? resolved : null;
}

async function loadHighlighter(language: string) {
  highlighter ??= import("highlight.js/lib/core").then((module) => module.default);
  const core = await highlighter;
  if (!core.getLanguage(language)) {
    const loader = LANGUAGES[language];
    if (loader === undefined) return core;
    core.registerLanguage(language, (await loader()).default as never);
  }
  return core;
}

/**
 * How long a growing run may stay one render behind.
 *
 * The whole reason this component needs a hook at all. `Markdown` is memoised on
 * `text`, and `EventList` hands it the *joined, still-growing* run — so the memo
 * key changed on every arriving token and never once hit for the message being
 * streamed. Every chunk therefore re-parsed the entire message from scratch, and
 * the cost is quadratic in its length.
 *
 * Measured 2026-07-31 against this repo's own remark-parse 11 / remark-gfm 4 /
 * remark-rehype 11: a realistic 20 KB answer delivered in 500 chunks cost 3,765 ms
 * of cumulative parsing against 17.1 ms for a single parse of the finished text —
 * 220x, with the last chunks costing ~15 ms each. On a phone, five to ten times
 * that, on the main thread, which is where the composer, the scroll and the
 * approve button also live.
 *
 * 150ms is under the threshold at which a reader perceives the text as lagging the
 * agent, and it turns "once per token" into "at most seven times a second". The
 * final state always renders: the timer is trailing, so the last commit lands
 * `STREAM_SETTLE_MS` after the agent stops talking whether or not anything else
 * arrives.
 */
const STREAM_SETTLE_MS = 150;

/**
 * The same idea for a fenced block, which settles on its own clock.
 *
 * Longer than the parse throttle because highlighting is the cheaper of the two
 * to be late with: unhighlighted code is still perfectly readable code, whereas
 * text that has not been parsed yet is not shown at all.
 */
const HIGHLIGHT_SETTLE_MS = 250;

/**
 * The text to actually parse, which for a run in flight is slightly stale.
 *
 * Returns the input unchanged when it is not moving — a completed run, which is
 * every run in a scrolled-back transcript, renders immediately and pays nothing.
 */
function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A commit is already scheduled; it will pick up `latest` when it fires, so
    // rescheduling here would push the deadline out on every chunk and a fast
    // talker would never render at all.
    if (settled === text || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setSettled(latest.current);
    }, STREAM_SETTLE_MS);
  }, [text, settled]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return settled;
}

/**
 * Hoisted to module scope, and that is load-bearing rather than tidy.
 *
 * Built inline, this object had a fresh identity on every render, so the memo on
 * {@link MarkdownBody} could never hit and the throttle above would have bought
 * nothing — the parse would still have run on every chunk.
 */
const COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  // Spread across the scale rather than collapsed onto it. `h2` and `h3` were both
  // `text-sm font-semibold`, which is the size of the body text they head, and
  // `h4` was `text-xs` — *smaller* than its own paragraphs. Agent output is the
  // main reading surface here and routinely uses `##`/`###` to structure a long
  // answer; at one size that structure degrades to "some lines are bold".
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-lg font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h5>,
  h4: ({ children }) => (
    <h6 className="mt-2 mb-1 text-sm font-semibold text-muted first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          /*
           * A link only where there is somewhere to go — see `openableHref`.
           *
           * The text is drawn either way; what is withheld is the anchor. An
           * agent naming a file writes a *path*, and a path resolved against this
           * origin is a URL on the control plane, which answered it with the SPA
           * fallback: tapping `about_me.txt` opened a second copy of the app.
           */
          a: ({ href, children }) => {
            const target = openableHref(href);
            if (target === null) return <>{children}</>;
            return (
              <a href={target} target="_blank" rel="noreferrer" className={LINK}>
                {children}
              </a>
            );
          },
          /*
           * **An image is a fetch nobody asked for, so it is drawn as text.**
           *
           * ⚠ This key was missing, and its absence was an exfiltration channel.
           * `a` above is routed through `openableHref` precisely because agent
           * output is untrusted text quoting an untrusted repository — but an
           * anchor needs a *tap*, and `![](https://…)` fell through to
           * react-markdown's default `<img src>`, whose transform allows `https:`.
           * So the browser issued a request to a host the agent chose, on render,
           * with no interaction, from the origin holding `reemoat.credential`, and
           * the query string carried whatever the agent had been told to put in
           * it. Prompt injection planted in a README, an issue body or a fetched
           * page is enough; there is no CSP anywhere in this app to catch it.
           *
           * The alt text is kept, which is the same trade `a` makes for an
           * unopenable href: the sentence is the agent's and is worth reading, the
           * network request is not ours to make. Nothing regresses visually
           * either, because there is no image an agent can name that this origin
           * would serve — a file under the workspace is reached through `GET
           * /sessions/:id/files` with a header and rendered by `ImagePreview`,
           * never by an `src` a browser follows.
           */
          img: ({ alt, src }) => (
            <span className="text-muted italic" title={typeof src === "string" ? src : undefined}>
              {typeof alt === "string" && alt.length > 0 ? alt : "image"}
            </span>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-edge-strong pl-3 text-muted">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-edge" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          // A table is the one block that genuinely cannot be made narrow, so it
          // scrolls inside its own box. Without the wrapper it widens the flex
          // column and takes the whole page sideways with it.
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-md border border-edge">
              <table className="w-full text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-raised">{children}</thead>,
          th: ({ children }) => <th className="px-2 py-1.5 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-t border-edge/60 px-2 py-1.5 align-top">{children}</td>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    // `react-markdown` gives a fenced block a `language-*` class and an
    // inline span none, which is the only way to tell them apart here.
    const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? null;
    if (language === null && !text.includes("\n")) {
      return <InlineCode text={text}>{children}</InlineCode>;
    }
    return <CodeBlock text={text.replace(/\n$/, "")} language={language} />;
  },
  // The default wraps a fenced block in `<pre>`, which would nest inside
  // the one `CodeBlock` renders.
  pre: ({ children }) => <>{children}</>,
};

/**
 * The parse itself, memoised on the *settled* text.
 *
 * Split from `Markdown` so the memo boundary sits below the throttle: the outer
 * component re-renders on every chunk (its `text` prop really did change), and
 * this one does not, which is the entire saving.
 */
const MarkdownBody = memo(function MarkdownBody({
  text,
  body,
}: {
  text: string;
  body: string;
}): ReactNode {
  return (
    <div className={`text-sm wrap-anywhere ${body}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const Markdown = memo(function Markdown({
  text,
  tone = "normal",
}: {
  text: string;
  /** `dim` is for thinking blocks, which are context rather than the answer. */
  tone?: "normal" | "dim" | "user";
}): ReactNode {
  // `user` reads as normal body text now, because the *bubble* carries the
  // distinction — see `Bubble.tsx`. It used to be `text-accent`, which was the
  // only thing marking a user message apart, and accent-on-accent inside a filled
  // bubble is close to unreadable.
  const body = tone === "dim" ? "text-muted" : "text-fg";
  return <MarkdownBody text={useSettledText(text)} body={body} />;
});

/**
 * An inline code span, which is sometimes a file this session made.
 *
 * The agent's closing message is where somebody looks for "here are your files",
 * and until now those paths were inert text — the download affordance lived on
 * `file_change` rows and inside expanded tool cards, which is not where anybody
 * reads. This puts it where the path already is: no new row, no new card, one
 * small glyph on a span that was going to be rendered anyway.
 *
 * `useFileAccess` rather than a prop, because `COMPONENTS` must keep its module
 * identity — see `files.ts` for the whole argument. The decision itself is
 * `downloadablePath`, which is pure and asserted; this component only draws it.
 *
 * It offers a **download** and never a preview. Whether the agent wanted the file
 * *shown* is a different question, and a path in prose does not answer it.
 */
function InlineCode({ text, children }: { text: string; children: ReactNode }): ReactNode {
  const files = useFileAccess();
  const [busy, setBusy] = useState(false);
  const rel = files?.spanTarget(text) ?? null;

  /*
   * A border as well as a fill, because the fill is not always a step.
   *
   * `bg-raised` is a chip on the `surface` pane, which is where the agent's half
   * of the conversation is drawn — but the user's own bubble *is* `bg-raised`, so
   * inside it this span was 1.00:1 with nothing around it and a backticked path in
   * your own message rendered as bare monospace text with some padding. The same
   * markdown then read as a chip on one side of the conversation and as loose text
   * on the other. A hairline is ground-independent, which a fill cannot be with
   * three paper values and a bubble occupying the middle one.
   */
  const span = (
    <code className="rounded-sm border border-edge-strong/25 bg-raised px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  );
  if (rel === null || files === null) return span;

  const name = filenameFor(rel) ?? rel;
  return (
    <button
      type="button"
      title={`Download ${name}`}
      aria-label={`Download ${name}`}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void files.download(rel, name).finally(() => setBusy(false));
      }}
      className="tap inline-flex items-baseline gap-1 rounded-sm bg-raised px-1 py-0.5 font-mono text-xs text-fg underline decoration-dotted underline-offset-2 hover:bg-edge disabled:opacity-50"
    >
      {children}
      <Icon as={busy ? Loader : Download} size={10} className={busy ? "animate-spin" : "opacity-60"} />
    </button>
  );
}

function CodeBlock({ text, language }: { text: string; language: string | null }): ReactNode {
  const resolved = language === null ? null : resolveLanguage(language);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /*
   * Debounced, for the same reason the parse above is throttled and with the same
   * shape of measurement: an 8 KB TypeScript fence delivered in 201 chunks cost
   * 266 ms of cumulative `core.highlight()` against 2.4 ms for one pass of the
   * finished block — 110x, each pass also triggering a `setHtml` re-render. This
   * stacks on top of the remark cost rather than being covered by it, because a
   * fence's text keeps changing after the surrounding markdown has settled.
   *
   * Trailing, so a block that has stopped growing is highlighted once. Until then
   * the plain `<code>` branch renders, which is exactly what already shows while
   * the lazy highlighter is still loading — so nothing regresses visually and
   * there is no new state to reason about.
   */
  const [settled, setSettled] = useState(text);
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(() => {
    if (settled === text) return;
    const timer = setTimeout(() => setSettled(latestText.current), HIGHLIGHT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text, settled]);

  useEffect(() => {
    if (resolved === null) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void loadHighlighter(resolved)
      .then((core) => {
        if (cancelled) return;
        setHtml(core.highlight(settled, { language: resolved, ignoreIllegals: true }).value);
      })
      .catch(() => {
        // Plain text is a perfectly good code block. Highlighting is the only
        // thing lost, and it is not worth an error surface.
      });
    return () => {
      cancelled = true;
    };
    // `settled` and not `text`: highlighting a block that is still arriving is the
    // cost this whole pair exists to remove.
  }, [settled, resolved]);

  const copy = (): void => {
    /*
     * Through `copyText`, which is the correction this comment used to be.
     *
     * It said the clipboard "is refused on an insecure origin, which is exactly
     * how this app is served on a tailnet. Nothing to say about it" — true about
     * the origin, wrong about there being nothing to do: `navigator.clipboard` is
     * *absent* there rather than refusing, so this button did nothing at all on
     * the one deployment it was written against. The fallback lives in one module
     * now and every copy in this app goes through it.
     *
     * A failure stays silent here, unlike the message button's toast: a code block
     * is selectable text sitting directly under the tap, so the remedy is on
     * screen and does not need saying.
     */
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    // The same argument as the inline span one screen up: this block is
    // `bg-raised`, and inside a user bubble — which is also `bg-raised` — a fence
    // had no block at all, only the language label and the Copy button hinting
    // that one was there. The border is what makes it a block on either ground;
    // `overflow-hidden` is what keeps the children's own corners inside it.
    <div className="group relative my-2 overflow-hidden rounded-md border border-edge-strong/25">
      <div className="flex items-center justify-between border-b border-edge bg-raised px-2.5 py-1.5">
        <span className="text-2xs text-faint">{language ?? "text"}</span>
        <button
          onClick={copy}
          className="tap press flex h-6 items-center gap-1 rounded-sm px-1.5 text-2xs text-muted hover:bg-surface hover:text-fg"
          aria-label="Copy code"
        >
          <Icon as={copied ? Check : Copy} size={11} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-raised p-2.5 font-mono text-xs">
        {html === null ? (
          <code>{text}</code>
        ) : (
          // Safe: the string is `highlight.js`'s own output, which escapes the
          // source it was given. Nothing from the agent reaches this unescaped.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
