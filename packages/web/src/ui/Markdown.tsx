import { Check, Copy, Download, Loader } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { filenameFor } from "../paths";
import { Icon, LINK } from "./bits";
import { copyText } from "./clipboard";
import { useFileAccess } from "./files";
import { openableHref } from "./links";
import { PAREN_LIST, remarkListDelimiter, remarkListItemBlocks } from "./mdlist";

/** No rehype-raw: agent output is untrusted, and react-markdown's HTML escaping is the security boundary. */

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

/** Trailing throttle on a streaming run: re-parsing on every chunk is quadratic in the message length. */
const STREAM_SETTLE_MS = 150;

const HIGHLIGHT_SETTLE_MS = 250;

function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text);
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Never reschedule: pushing the deadline out on every chunk would keep a fast talker from ever rendering.
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

/** Hoisted: a fresh plugin array per render would defeat MarkdownBody's memo. */
const REMARK_PLUGINS: Parameters<typeof ReactMarkdown>[0]["remarkPlugins"] = [
  remarkGfm,
  remarkListDelimiter,
  remarkListItemBlocks,
];

/** Module scope is load-bearing: a fresh object per render would defeat MarkdownBody's memo. */
const COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-lg font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h5>,
  h4: ({ children }) => (
    <h6 className="mt-2 mb-1 text-sm font-semibold text-muted first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5">{children}</ul>,
          // start is passed through, or a list beginning 10) is drawn from 1; list-decimal stays as the fallback marker.
          ol: ({ children, className, start }) => (
            <ol
              start={start}
              className={`my-1.5 ml-4 list-decimal space-y-0.5${
                typeof className === "string" && className.includes(PAREN_LIST) ? ` ${PAREN_LIST}` : ""
              }`}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          // Only an openable href becomes an anchor; a bare path would resolve against this origin.
          a: ({ href, children }) => {
            const target = openableHref(href);
            if (target === null) return <>{children}</>;
            return (
              <a href={target} target="_blank" rel="noreferrer" className={LINK}>
                {children}
              </a>
            );
          },
          // Drawn as text, never as an image the browser fetches: an agent-chosen URL loaded on render is an exfiltration channel.
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
    const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? null;
    if (language === null && !text.includes("\n")) {
      return <InlineCode text={text}>{children}</InlineCode>;
    }
    return <CodeBlock text={text.replace(/\n$/, "")} language={language} />;
  },
  // The default pre would nest around the one CodeBlock renders.
  pre: ({ children }) => <>{children}</>,
};

/** The parse, memoised on the settled text below the throttle, which is the entire saving. */
const MarkdownBody = memo(function MarkdownBody({ text, body }: { text: string; body: string }): ReactNode {
  return (
    // sel-root lives here because every markdown passes through this div; a flex container above it brings WebKit's selection fill back.
    <div className={`sel-root text-sm wrap-anywhere ${body}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
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
  /** `dim` is for thinking blocks, which are context rather than the answer. A person's own message is never markdown: `Bubble.tsx`. */
  tone?: "normal" | "dim";
}): ReactNode {
  const body = tone === "dim" ? "text-muted" : "text-fg";
  return <MarkdownBody text={useSettledText(text)} body={body} />;
});

// Offers a download, never a preview, for a span naming a file this session touched.
function InlineCode({ text, children }: { text: string; children: ReactNode }): ReactNode {
  const files = useFileAccess();
  const [busy, setBusy] = useState(false);
  const rel = files?.spanTarget(text) ?? null;

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

  // Debounced like the parse: re-highlighting a growing fence on every chunk is the same quadratic cost.
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
        // Plain text is a fine code block; highlighting is not worth an error surface.
      });
    return () => {
      cancelled = true;
    };
  }, [settled, resolved]);

  const copy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
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
          // Safe: highlight.js escapes the source it is given.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
