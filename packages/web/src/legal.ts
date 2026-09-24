// Legal documents and their URL rules, outside router.ts so webcheck can import them; deliberately not gate screens (Q3.598).
// OPERATOR is one operator's party, which a fork must replace (Q1.638).

export { OPERATOR, operatorIncomplete, legalPublishable } from "./legal/operator";

export type LegalDoc = "terms" | "acceptable-use" | "privacy";

export const LEGAL_DOCS: readonly LegalDoc[] = ["terms", "acceptable-use", "privacy"];

export type LegalLang = "en" | "ka";

export const LEGAL_LANGS: readonly LegalLang[] = ["en"];

/** No link block by design: an author-chosen href rendered at this origin is an injection sink. */
export type LegalBlock =
  | { kind: "para"; text: string }
  | { kind: "list"; items: readonly string[] }
  /** A sentence ending in a link to one of the other documents. */
  | { kind: "ref"; text: string; doc: LegalDoc; label: string }
  /** A sentence ending in an address somebody writes to. */
  | { kind: "contact"; text: string; email: string };

export interface LegalSection {
  // Stable once published: it is the fragment people cite.
  id: string;
  heading: string;
  blocks: readonly LegalBlock[];
}

/** Rendered on the page because CC BY requires the credit where the work is read; webcheck asserts every field. */
export interface LegalCredit {
  work: string;
  author: string;
  licence: "CC BY 4.0" | "CC0 1.0";
  workUrl: string;
  licenceUrl: string;
}

export interface LegalDocument {
  doc: LegalDoc;
  lang: LegalLang;
  /** `YYYY-MM-DD`, and the date the *text* changed — never a build stamp. */
  effective: string;
  lead: string;
  sections: readonly LegalSection[];
  credits: readonly LegalCredit[];
}

export function parseLegalDoc(segments: readonly (string | undefined)[]): LegalDoc | null {
  const first = segments[0];
  if (first === undefined) return null;
  return LEGAL_DOCS.find((doc) => doc === first) ?? null;
}

export function isLegalPath(pathname: string): boolean {
  return parseLegalDoc(pathname.split("/").filter((part) => part.length > 0)) !== null;
}

export function legalPath(doc: LegalDoc): string {
  return `/${doc}`;
}

export function legalTitle(doc: LegalDoc): string {
  switch (doc) {
    case "terms":
      return "Terms of Use";
    case "acceptable-use":
      return "Acceptable Use Policy";
    case "privacy":
      return "Privacy Policy";
  }
}

/** Answers for the app bundle only; the gate bundle passes its own upLabel to LegalScreen. */
export function legalUpLabel(signedIn: boolean): string {
  return signedIn ? "Back to your machines" : "Back to sign in";
}
