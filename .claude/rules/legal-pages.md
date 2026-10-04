---
paths:
  - packages/web/src/legal.ts
  - packages/web/src/legal/*
  - packages/web/src/ui/legal/*
  - packages/web/src/ui/gate/Gate.tsx
  - packages/web/src/ui/gate/GateCard.tsx
  - packages/web/scripts/webcheck.legal-and-consent.ts
---

# The three documents, and the box that points at them

`/terms`, `/acceptable-use`, `/privacy`: readable with no credential and with one.

## A route, not a sixth gate screen

A top-level `Route` arm, `{ name: "legal"; doc: LegalDoc }`, every URL rule in `legal.ts`,
the screen in `ui/legal/LegalScreen.tsx`, drawn in `App.tsx` above `signed_out` **and**
`loading`, beside the gate's branch. Not a `GateScreen`: `gate.ts` and `depthOf`'s gate arm
define those as screens before a credential, `GateCard` is a form measure where a document
wants `COLUMN`, and `ToHandoff` replaces always, on a token a document lacks. Q3.598.

- **Four switches are compile-enforced** (`depthOf`, `sheetKind`, `sheetTitle`,
  `screenOf`); **three sites take a new arm in silence** (`isSheet`, an `||` chain;
  `isOverlayPath`, a list of literals; `sheetUpLabel`, an early return). Only the case table
  in `webcheck.plugin-reach-and-mirror.ts` covers those three; a new route arm goes in it.
- **`upFrom` must answer a path, never `null`**: `LegalScreen` draws its way out only when
  `up !== null`, so `GateApp` hands it a literal `/app`.
- **`parseLegalDoc` and `parseGateScreen` stay disjoint, and `parse` asks the gate first**,
  or a document named `register` would silently lose to the password screen. Asserted both
  ways.

## A document is data

`LegalBlock` has four kinds, `para`, `list`, `ref`, `contact`, and **no
`{ kind: "link"; href }`, ever**: a prose-chosen href at this origin is the sink
`Markdown.tsx` refuses by disabling `rehype-raw`. The only outbound URLs are the two on each
`LegalCredit`, built by the renderer; `webcheck` compares the prose's URL set to exactly
those.

**Never `Markdown`**: it puts `react-markdown`, `remark-gfm` and the `highlight.js` core back
on `App.tsx`'s path and demotes `h1` to `<h3>`. The prose is `lazy()`-loaded for the same
reason.

`OPERATOR` lives in `legal/operator.ts`, not `legal.ts`, which imports the prose: there the
prose would read it in its temporal dead zone, a `ReferenceError` on first paint.

**Two privacy-notice claims are true only because of code**: transcripts never reach the
control plane, and *"no analytics and no third-party scripts"*, enforced by
`script-src 'self'`. Widening that header, or a server-side transcript index, makes a
published document false.

## The party is compiled in, with a marker

`cp-accounts.md` forbids compiled-in defaults for environment-only values (AGPL; forks run
their own control planes). The party is compiled in anyway, deliberately, in `OPERATOR`, with
a warning block at the head of `legal.ts` in `SOURCE_URL`'s shape. **The prose is the
software's; the party is one deployment's.** Q1.638. `operatorIncomplete` makes an unfilled
field a counted `skip`, not a silent pass.

## The consent box

Inside `Register`'s `<form>`, **before** the submit button, never in `GateCard`'s `footer`
(the way back's slot). **A control that gates another comes before it.** Q3.599.

`GateCard.tsx`'s tombstone says the AGPL §13 `SourceNotice` must not be restored; this box
is not that. §13 is discharged in artefacts (Q3.440); consent is a term of an act at the
moment of the act. Read that docblock before putting anything else legal on a gate screen.

The label is generated from `LEGAL_DOCS` and named by `legalTitle`, so a fourth document
appears by existing. It gates `ready` and sends `acceptedTerms`, which `POST /v1/register`
refuses without, **only where the instance publishes documents**, and **nothing is stored**:
no column, timestamp or version. The route states the requirement; it proves nothing.

## One switch, three effects

`REEMOAT_CP_LEGAL_DOCUMENTS` is env-only with no compiled default, the third member of
`cp-accounts.md`'s family: a deployment claims the documents rather than inherits them. Off,
the default: no `/terms` page, no consent box, no requirement on the register route.
`instance.ts` takes only literal `true` as a claim (`catalogue` and `appDownload` take any
absolute URL), since this one puts a named party's contract in front of somebody.

`App.tsx` has **three** states for a document route: claimed, not claimed, not yet known.
Unanswered, it waits; never drawn optimistically on a fork's screen.

The links are anchors with `target="_blank"`, the app's one same-origin `_blank`: four
fields (two passwords) and the tick are component state a navigation loses. A click on
interactive content inside a `<label>` does not activate it, so the links do not tick the
box.

## English only

`LEGAL_LANGS` is what exists; `LegalLang` is what may. A language is a second table value and
a control on the screen, **never a localisation layer**. Q7.134.
