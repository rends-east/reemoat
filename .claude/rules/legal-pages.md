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

`/terms`, `/acceptable-use`, `/privacy`. Readable **with no credential and with
one**, which is the whole shape of this area.

## They are a route, not a sixth gate screen

A top-level `Route` arm, `{ name: "legal"; doc: LegalDoc }`, every URL rule in
`legal.ts`, the screen in `ui/legal/LegalScreen.tsx`, drawn in `App.tsx` above
`signed_out` **and** above `loading`, beside the gate's branch.

Adding them to `GateScreen` instead is cheaper by every count and breaks four
written things: `gate.ts` defines that family as the screens reached *before there
is a credential*; `depthOf`'s gate arm argues those screens are "the sign-in form
with different fields"; `GateCard` is `max-w-sm`, a **form** measure, where a
document wants `COLUMN`; and `ToHandoff` (named `BackToSignIn` until this branch,
when the gate's exits stopped naming a screen this bundle does not contain)
replaces always, justified by a token a document does not carry. Q3.598.

**Four switches are compile-enforced** (`depthOf`, `sheetKind`, `sheetTitle`,
`screenOf`) and **three sites take a new arm in silence**: `isSheet` is an `||`
chain, `isOverlayPath` a list of literals, `sheetUpLabel` an early return. The
case table in `webcheck.plugin-reach-and-mirror.ts` is the only thing covering
those three — a new route arm belongs in it.

⚠ **`upFrom` must answer a path and never `null`.** `LegalScreen` draws its way
out only when `up !== null`, so a document opened from the sign-up form would have
no way back to it at all — which is why `GateApp` hands it a literal `/app`.

⚠ **`parseLegalDoc` and `parseGateScreen` must stay disjoint, and `parse` asks the
gate first.** A document named `register` would lose, silently, to the one screen
on this origin where a password is typed. Asserted in both directions.

## A document is data, and the union is short on purpose

`LegalBlock` has four kinds — `para`, `list`, `ref`, `contact` — and **no
`{ kind: "link"; href }`, ever**: an href chosen by whoever writes the prose,
rendered at this origin, is the sink `Markdown.tsx` refuses by disabling
`rehype-raw`. The only outbound URLs in the feature are the two on each
`LegalCredit`, which the renderer builds; `webcheck` compares the URL set in the
prose against exactly those.

**Never `Markdown`.** It would put `react-markdown`, `remark-gfm` and the
`highlight.js` core back on the path `App.tsx` measured from 655.9 kB down to
346.8 kB, and it demotes `h1` to `<h3>` because it exists for untrusted agent
output. The prose is `lazy()`-loaded for the same measurement.

`OPERATOR` lives in `legal/operator.ts` rather than in `legal.ts` because the
prose reads it at run time and `legal.ts` imports the prose at run time — with the
constant in `legal.ts` the prose executes first, imports being hoisted, and reads
it in its temporal dead zone. A `ReferenceError` on first paint, not a type error.

⚠ **Two claims in the privacy notice are true only because of code.** Transcripts
never reaching the control plane, and *"no analytics and no third-party scripts"* —
the second is enforced by `script-src 'self'`. Widening that header, or adding a
server-side transcript index, makes a published document false to a regulator
rather than merely out of date.

## The party is compiled in, with a marker, and that is a departure

`cp-accounts.md` states the rule for the two environment-only values: no
compiled-in default, *because this is AGPL software and forks run their own
control planes.* Terms name a legal person and are drawn on every instance's
sign-up screen, so they are that argument sharpened — and they are compiled in
anyway, deliberately, in `OPERATOR`, with a ⚠ block at the head of `legal.ts` in
`SOURCE_URL`'s shape. Q1.638 carries the argument and the exact price of the way
back. **The prose is the software's; the party is one deployment's.**

`operatorIncomplete` is why an unfilled field is a counted `skip` rather than a
silent pass.

## The consent box

Inside `Register`'s `<form>`, **before** the submit button, never in `GateCard`'s
`footer` — that slot is the one place each screen keeps for the way back, under a
rule, which is chrome about the page rather than a term of the act. It sat *under*
the button first and read well in prose; on the screen the button is disabled until
the box is ticked, so its own precondition was below it and a press did nothing for
a reason the reader could not see. **A control that gates another comes before
it.** Q3.599.

⚠ **`GateCard.tsx` carries a tombstone saying the AGPL §13 `SourceNotice` must not
be restored, and this box is not that.** §13 is an obligation the licence places
on the operator and Q3.440 discharged it in artefacts; consent is a term of an act
at the moment of the act, which nothing in a tarball can carry. Read that docblock
before putting anything else legal on a gate screen.

The label is generated from `LEGAL_DOCS` and named by `legalTitle`, so a fourth
document appears by existing. It gates `ready` and sends `acceptedTerms`, which
`POST /v1/register` refuses without — but **only where the instance publishes
documents**, and **nothing is stored**: no column, no timestamp, no version. The
route *states* the requirement; it does not prove anything, since a caller that
sends `true` is indistinguishable from a person who ticked a box.

## One switch, three effects

`REEMOAT_CP_LEGAL_DOCUMENTS` is env-only with no compiled default, the third
member of the family `cp-accounts.md` describes and the sharpest case for it: the
documents ship in this bundle and name **one party**, so a deployment claims them
rather than inherits them. Off — the default — means no `/terms` page, no consent
box, and no requirement on the register route. `instance.ts` reads it strictly:
only literal `true` is a claim, where `catalogue` and `appDownload` beside it take any
absolute URL, because those lose a feature when they read wrong and this one puts
a named party's contract in front of somebody.

⚠ `App.tsx` has **three** states for a document route, not two: claimed, not
claimed, and *not yet known*. While the config is unanswered it waits — drawing
optimistically would put one operator's contract on a fork's screen for a frame.

The links are anchors with `target="_blank"`, the one same-origin `_blank` in this
app: four fields are filled in by then, two of them passwords, and the tick is
component state, so a navigation loses all five. A click targeted at interactive
content inside a `<label>` does not activate the labelled control, which is why
the links do not tick the box.

## English only

`LEGAL_LANGS` is what exists; `LegalLang` is what may. Adding a language is a
second value in the table and a control on the screen, **never a localisation
layer** — this app has never had one and this is not the place to grow one.
Q7.134.
