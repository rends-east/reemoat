import type { ReactNode } from "react";

import {
  LEGAL_DOCS,
  legalPath,
  legalTitle,
  legalUpLabel,
  type LegalBlock,
  type LegalCredit,
  type LegalDoc,
} from "../../legal";
import { legalDocument } from "../../legal/text";
import { navigate } from "../../router";
import { COLUMN, LINK, SETTINGS_SECTION } from "../bits";

/** A document at `COLUMN` width rather than `GateCard`'s, and never through `Markdown` (Q3.598). */
export function LegalScreen({
  doc,
  up,
  signedIn,
  upLabel,
}: {
  doc: LegalDoc;
  /** Where the way out goes; `null` draws none, and neither caller passes it. */
  up: string | null;
  signedIn: boolean;
  /** The label for a caller outside the app, whose roots `legalUpLabel` cannot name. */
  upLabel?: string;
}): ReactNode {
  const text = legalDocument(doc);
  const others = LEGAL_DOCS.filter((other) => other !== doc);
  return (
    // Safe-area insets on the shell, not the column, whose class string webcheck reads whole.
    <div className="pt-safe pb-safe min-h-full">
      <div className={`${COLUMN} px-4 py-8 text-sm`}>
        <h1 className="text-xl font-semibold">{legalTitle(doc)}</h1>
        <p className="mt-1 text-xs text-muted">Effective {text.effective}</p>
        <p className="mt-4 text-muted">{text.lead}</p>

        {text.sections.map((section, index) => (
          <section key={section.id} id={section.id} className={index === 0 ? "mt-8" : SETTINGS_SECTION}>
            {/* Not `SETTINGS_HEADING`: that eyebrow sits below body size, and appending to it is a Tailwind no-op (Q5.115). */}
            <h2 className="text-base font-semibold text-fg">{section.heading}</h2>
            {section.blocks.map((block, position) => (
              <Block key={position} block={block} />
            ))}
          </section>
        ))}

        <footer className="mt-8 border-t border-edge pt-4">
          <p className="text-xs text-muted">
            {others.map((other, position) => (
              <span key={other}>
                {position > 0 ? " · " : ""}
                {/* `replace`, so reading all three leaves no history for Back. */}
                <button
                  type="button"
                  onClick={() => navigate(legalPath(other), true)}
                  className={`tap ${LINK}`}
                >
                  {legalTitle(other)}
                </button>
              </span>
            ))}
          </p>
          <Credits credits={text.credits} />
          {up !== null && (
            <button
              type="button"
              onClick={() => navigate(up, true)}
              className="tap mt-3 block text-xs text-muted hover:text-fg"
            >
              {upLabel ?? legalUpLabel(signedIn)}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Block({ block }: { block: LegalBlock }): ReactNode {
  switch (block.kind) {
    case "para":
      return <p className="mt-3">{block.text}</p>;
    case "list":
      return (
        <ul className="mt-3 ml-4 list-disc space-y-1">
          {block.items.map((item) => (
            <li key={item} className="pl-0.5">
              {item}
            </li>
          ))}
        </ul>
      );
    case "ref":
      return (
        <p className="mt-3">
          {block.text}{" "}
          <button type="button" onClick={() => navigate(legalPath(block.doc), true)} className={`tap ${LINK}`}>
            {block.label}
          </button>
          .
        </p>
      );
    case "contact":
      return (
        <p className="mt-3">
          {block.text}{" "}
          <a href={`mailto:${block.email}`} className={LINK}>
            {block.email}
          </a>
          .
        </p>
      );
  }
}

/** CC BY 4.0 requires the credit where the work is read; the CC0 credit is a courtesy, kept anyway. */
function Credits({ credits }: { credits: readonly LegalCredit[] }): ReactNode {
  return (
    <p className="mt-2 text-2xs text-muted">
      {credits.map((credit, position) => (
        <span key={credit.workUrl}>
          {position > 0 ? " " : ""}
          Adapted from the{" "}
          <a href={credit.workUrl} target="_blank" rel="noreferrer" className={LINK}>
            {credit.author} {credit.work}
          </a>{" "}
          under{" "}
          <a href={credit.licenceUrl} target="_blank" rel="noreferrer" className={LINK}>
            {credit.licence}
          </a>
          .
        </span>
      ))}
    </p>
  );
}
