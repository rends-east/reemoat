import type { LegalDoc, LegalDocument, LegalLang } from "../legal";

import { ACCEPTABLE_USE_EN } from "./acceptableUse";
import { PRIVACY_EN } from "./privacy";
import { TERMS_EN } from "./terms";

// The only module importing the prose, kept out of legal.ts so the policies stay out of the entry chunk; webcheck asserts legal.ts imports none.
const TEXT: Partial<Record<LegalLang, Record<LegalDoc, LegalDocument>>> = {
  en: {
    terms: TERMS_EN,
    "acceptable-use": ACCEPTABLE_USE_EN,
    privacy: PRIVACY_EN,
  },
};

/** Falls back to English rather than refusing: a consent link to a blank page is worse. */
export function legalDocument(doc: LegalDoc, lang: LegalLang = "en"): LegalDocument {
  const inLang = TEXT[lang]?.[doc];
  if (inLang !== undefined) return inLang;
  const english = TEXT["en"];
  if (english === undefined) throw new Error("no legal text in any language");
  return english[doc];
}
