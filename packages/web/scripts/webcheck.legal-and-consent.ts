import { readFileSync } from "node:fs";

import { check, report, skip } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/**
 * The three documents, and the box that points at them.
 *
 * A sibling of its own rather than lines appended to
 * `webcheck.gate-and-server-settings.ts`, whose banner declares its subject as
 * the screens reached *before there is a credential* — and a document is defined
 * by being readable with one **and** without.
 */
process.stdout.write("\nthe three documents, and the box that points at them\n");

{
  const {
    LEGAL_DOCS,
    LEGAL_LANGS,
    OPERATOR,
    isLegalPath,
    legalPath,
    legalTitle,
    legalUpLabel,
    operatorIncomplete,
    legalPublishable,
    parseLegalDoc,
  } = await import("../src/legal.js");
  const { legalDocument } = await import("../src/legal/text.js");
  const { GATE_SCREENS, gatePath, isGatePath } = await import("../src/gate.js");
  const { depthOf, isSheet, sheetKind, sheetTitle, upFrom } = await import("../src/nav.js");
  const { isOverlayPath } = await import("../src/ui/overlay.js");

  /* ---- which document a path names ---- */

  check("there are documents to have checked", LEGAL_DOCS.length, 3);
  check("no segments is no document", parseLegalDoc([]), null);
  check("an unrelated path is none", parseLegalDoc(["settings"]), null);
  // `parseGateScreen`'s rule: the case a URL happens to arrive in never decides.
  check("and the case it arrives in does not decide", parseLegalDoc(["Terms"]), null);
  check("whole segments only, the isOverlayPath rule", isLegalPath("/termsish"), false);
  check("and a real one is a document path", isLegalPath("/terms"), true);
  for (const doc of LEGAL_DOCS) {
    check(`${doc} names itself`, parseLegalDoc([doc]), doc);
    check(`${doc} round-trips through its own path`, parseLegalDoc(legalPath(doc).slice(1).split("/")), doc);
  }
  /*
   * ⚠ **The address may be an acronym; the title may not.** `sheetTitle`'s
   * standing rule — a link written down last week has to keep opening the screen,
   * and a reader who has never met the acronym must not be shown one.
   */
  check("the acronym stays in the address", legalTitle("acceptable-use"), "Acceptable Use Policy");
  check("and no title is just the address back", LEGAL_DOCS.filter((doc) => legalTitle(doc) === doc), []);

  /*
   * ⚠ **Disjoint from the gate, in both directions, and one direction is silent.**
   * `parse` asks the gate first, so a document named `register` would lose to the
   * one screen on this origin where a password is typed — and lose quietly. A gate
   * screen named `privacy` would steal the document, which at least shows.
   */
  check("no document collides with a gate screen", LEGAL_DOCS.filter((doc) => isGatePath(legalPath(doc))), []);
  check(
    "and no gate screen collides with a document",
    GATE_SCREENS.filter((screen) => isLegalPath(gatePath(screen))),
    [],
  );

  /*
   * ⚠ **A document is a screen, not a pop-up — and three of the places that
   * decide so fail silently.** `depthOf`, `sheetKind`, `sheetTitle` and
   * `screenOf` are exhaustive switches and a new route arm is a compile error in
   * each; `isSheet` is an `||` chain and `isOverlayPath` a list of string
   * literals, so a seventh arm reaches both and changes nothing. This is the half
   * the compiler cannot hold.
   */
  const asRoute = { name: "legal", doc: "terms" } as const;
  check("a document is one level in, like a session", depthOf(asRoute as never), 1);
  check("it is not a pop-up, asked from the route", isSheet(asRoute as never), false);
  check("nor from its own path", isOverlayPath(legalPath("terms")), false);
  check("so no sheet owns it", sheetKind(asRoute as never), null);
  check("and no panel head names it", sheetTitle(asRoute as never), null);
  /*
   * ⚠ **The way out is a destination and never `null`.** `App` hands this value
   * straight to `LegalScreen`'s `up`, which draws its control only where there is
   * somewhere for it to go — so a document opened from the sign-up form would have
   * no way back to it at all.
   */
  check("the way out of a document is the root", upFrom(asRoute as never, "/", null), "/");
  check("and never nothing", upFrom(asRoute as never, "/", null) !== null, true);
  check(
    "the control names where it goes rather than saying Back",
    [legalUpLabel(false), legalUpLabel(true)],
    ["Back to sign in", "Back to your machines"],
  );

  /* ---- the prose, driven rather than described ---- */

  const docs = LEGAL_DOCS.map((doc) => legalDocument(doc));
  const textOf = (block: (typeof docs)[number]["sections"][number]["blocks"][number]): string =>
    block.kind === "list" ? block.items.join(" ") : block.text;

  check("only the languages that exist are offered", [...LEGAL_LANGS], ["en"]);
  check("every document is filed under its own key", docs.filter((one, at) => one.doc !== LEGAL_DOCS[at]), []);
  check("and every one of them is in the language it claims", docs.filter((one) => one.lang !== "en"), []);
  /*
   * The floor. A sweep over an empty table passes silently, which is this
   * driver's standing failure mode — four assertions were once green over broken
   * code for want of exactly this line. Q5.114.
   */
  report(
    "there is prose to have checked",
    docs.every((one) => one.sections.length >= 5),
    `${docs.reduce((n, one) => n + one.sections.length, 0)} sections, ` +
      `${docs.reduce((n, one) => n + one.sections.reduce((m, s) => m + s.blocks.length, 0), 0)} blocks`,
  );
  check("every section is headed", docs.flatMap((one) => one.sections.filter((s) => s.heading.trim() === "")), []);
  check(
    "and carries something under the heading",
    docs.flatMap((one) => one.sections.filter((s) => s.blocks.length === 0).map((s) => `${one.doc}/${s.id}`)),
    [],
  );
  check(
    "no block is empty",
    docs.flatMap((one) =>
      one.sections.flatMap((s) => s.blocks.filter((b) => textOf(b).trim() === "").map(() => `${one.doc}/${s.id}`)),
    ),
    [],
  );
  // Section ids are the fragment somebody cites back at you in a dispute, so they
  // are addressable and they are unique within their document.
  check(
    "section ids are unique within a document",
    docs.filter((one) => new Set(one.sections.map((s) => s.id)).size !== one.sections.length).map((one) => one.doc),
    [],
  );
  check(
    "and every one of them is URL-safe",
    docs.flatMap((one) => one.sections.filter((s) => !/^[a-z][a-z0-9-]*$/.test(s.id)).map((s) => s.id)),
    [],
  );
  check(
    "every cross-reference names a document that exists",
    docs.flatMap((one) =>
      one.sections.flatMap((s) =>
        s.blocks.filter((b) => b.kind === "ref" && !LEGAL_DOCS.includes(b.doc)).map(() => one.doc),
      ),
    ),
    [],
  );
  check(
    "and every address somebody is told to write to is one",
    docs.flatMap((one) =>
      one.sections.flatMap((s) =>
        s.blocks.filter((b) => b.kind === "contact" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)).map(() => one.doc),
      ),
    ),
    [],
  );
  /*
   * ⚠ **The date is ISO and nothing renders it through a locale.** A policy's
   * date has to read the same in every country the instance is reached from, and
   * `YYYY-MM-DD` is what `CHANGELOG.md` and every measurement in
   * `docs/DECISIONS.md` already use. The round-trip is what catches `2026-02-31`,
   * which the shape alone accepts.
   */
  check("every document states a date", docs.filter((one) => !/^\d{4}-\d{2}-\d{2}$/.test(one.effective)), []);
  check(
    "and it is a real one",
    docs.filter((one) => new Date(`${one.effective}T00:00:00Z`).toISOString().slice(0, 10) !== one.effective),
    [],
  );
  check("the shape sweep can see a date that is not one", /^\d{4}-\d{2}-\d{2}$/.test("2026-9-1"), false);
  check(
    "and the round-trip can see a day that does not exist",
    new Date("2026-02-31T00:00:00Z").toISOString().slice(0, 10) === "2026-02-31",
    false,
  );

  /*
   * ⚠ **CC BY 4.0 is a condition rather than a courtesy**, and it asks for the
   * credit where the work is read. A line lost to a tidy-up is a licence breach
   * that looks like housekeeping, so every field of it is asserted.
   */
  check("every document says where its text came from", docs.filter((one) => one.credits.length === 0), []);
  check(
    "and every credit names a work, an author and two absolute URLs",
    docs.flatMap((one) =>
      one.credits
        .filter(
          (credit) =>
            credit.work === "" ||
            credit.author === "" ||
            !credit.workUrl.startsWith("https://") ||
            !credit.licenceUrl.startsWith("https://"),
        )
        .map(() => one.doc),
    ),
    [],
  );
  // Pinned rather than derived: which upstream each document is adapted from is a
  // fact about this work, and deriving it from the data would assert the data
  // against itself.
  check(
    "each document names the licences it is actually under",
    LEGAL_DOCS.map((doc) =>
      legalDocument(doc)
        .credits.map((credit) => credit.licence)
        .sort(),
    ),
    [["CC BY 4.0"], ["CC BY 4.0", "CC0 1.0"], ["CC BY 4.0"]],
  );

  /*
   * **What is not filled in yet is said out loud.** `skip` is counted and printed
   * in `finish()`'s summary precisely so a run that checked nothing cannot read
   * as a run that agreed. A placeholder in the operator's own details is a thing
   * to be told about on every run rather than a thing to fail on while the rest
   * of the work is being reviewed.
   */
  const unfilled = operatorIncomplete();
  if (unfilled.length > 0) {
    skip("the operator's own details are filled in", `${unfilled.join(", ")} still placeholder`);
  } else {
    check("the operator's own details are filled in", unfilled, []);
  }
  check("the contact address is one", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(OPERATOR.email), true);
  /*
   * ⚠ **And the placeholder now *closes the feature* rather than only being
   * reported.** The `skip` above is the honest way to say "this is not filled in
   * yet" while work is in progress; what it cannot do is stop a release, because a
   * skipped case exits 0. So the two are asserted as a pair: while any required
   * field is a placeholder `legalPublishable()` is false, and `App` and the consent
   * box both read it — an unfinished document is an address that names nothing
   * here, exactly as an unclaimed one is.
   *
   * `mailProvider` is the field this exists for. It is named twice in the Privacy
   * Policy, once as a data *processor*, so an unfilled one is a missing statutory
   * disclosure rendered verbatim as `TODO` to somebody deciding whether to trust
   * the service with an address.
   */
  check(
    "an unfinished document cannot be published",
    legalPublishable(),
    unfilled.length === 0,
  );

  const proseFiles = ["terms", "acceptableUse", "privacy"] as const;
  const proseRaw = proseFiles.map((name) => readFileSync(new URL(`../src/legal/${name}.ts`, import.meta.url), "utf8"));
  const prose = proseRaw.map(stripComments);
  report("the prose modules were found", prose.every((text) => text.length > 2000), `${prose.length} files`);
  const stillTodo = proseFiles.filter((_, at) => (prose[at] ?? "").includes("TODO"));
  if (stillTodo.length > 0) {
    skip("no document still carries a placeholder", `${stillTodo.join(", ")} carry TODO`);
  } else {
    check("no document still carries a placeholder", stillTodo, []);
  }

  /*
   * ⚠ **The prose carries no link of its own.** An href chosen by whoever writes
   * a document, rendered at this origin, is the sink `Markdown.tsx` refuses by
   * disabling `rehype-raw`. The only outbound URLs in the whole feature are the
   * two on each credit, and this compares the sets rather than counting.
   */
  const allowed = new Set(docs.flatMap((one) => one.credits.flatMap((c) => [c.workUrl, c.licenceUrl])));
  /*
   * ⚠ **Raw source here, and it is not an oversight.** `stripComments` removes
   * `//` to end of line, and every URL contains `//` — so the stripped text has no
   * URLs in it at all and this sweep passed over nothing. The docblocks in these
   * three files deliberately cite no URL, which is what makes the raw text safe
   * to read; the check below would see it if one appeared.
   */
  const found = new Set(proseRaw.flatMap((text) => [...text.matchAll(/https:\/\/[^"'\s)]+/g)].map((m) => m[0])));
  report("the URL sweep can see a URL", found.size > 0, `${found.size} distinct`);
  check("and every one of them is a credit's", [...found].filter((url) => !allowed.has(url)), []);

  /* ---- the page ---- */

  const screen = stripComments(readFileSync(new URL("../src/ui/legal/LegalScreen.tsx", import.meta.url), "utf8"));
  report("the document page was found", screen.length > 600, `${screen.length} chars after comments`);
  /*
   * ⚠ **The reading measure, not the form measure.** `GateCard` is `max-w-sm`,
   * sized for four fields; a policy at that width is a column about forty
   * characters wide. `COLUMN` is the only reading measure this app has.
   */
  check("a document is set at the reading measure", /\$\{COLUMN\}/.test(screen), true);
  check("and never at the form measure", /max-w-sm/.test(screen), false);
  check("nor at a measure of its own", /max-w-\[/.test(screen), false);
  check("nor at a size off the scale", /text-\[/.test(screen), false);
  /*
   * **The size is stated on the column and the blocks carry rhythm only** — the
   * pair `webcheck.typography.ts` asserts for the two mono spans that inherit
   * their line's step, and for its reason: a size on a container with no blocks
   * under it passes trivially, and blocks with a size each drift apart.
   */
  check(
    "the column states the body size and a paragraph inherits it",
    [/\$\{COLUMN\} px-4 py-8 text-sm/.test(screen), /className="mt-3">\{block\.text\}/.test(screen)],
    [true, true],
  );
  /*
   * ⚠ **The property rather than the constant, because the constant was the
   * defect.** This asserted `SETTINGS_HEADING` was used — the settings eyebrow,
   * `text-2xs text-muted uppercase` — over a `text-sm` column, so it was green
   * over 39 section headings drawn two steps *below* the paragraphs they head.
   * What matters is that a heading outranks its body, so that is what is checked:
   * `text-base` against the column's `text-sm`, at full contrast, and the eyebrow
   * explicitly absent.
   */
  check(
    "a section heading outranks the body it heads",
    [
      /<h2 className="text-base font-semibold text-fg">/.test(screen),
      /SETTINGS_HEADING/.test(screen),
    ],
    [true, false],
  );
  check("and later sections take the shared section rule", /SETTINGS_SECTION/.test(screen), true);
  // Appending a colour to either is a silent no-op: two members of one family,
  // resolved by Tailwind's alphabetical emission. Q5.115.
  check("and no colour is appended to either", /\$\{SETTINGS_(HEADING|SECTION)\} text-/.test(screen), false);
  // One shell for three documents rather than a copy per document.
  check("there is one page shell", (screen.match(/min-h-full/g) ?? []).length, 1);
  /*
   * ⚠ **And the page does not draw the agent-output pipeline.** `App.tsx`
   * measured the sign-in path from 655.9 kB down to 346.8 kB by keeping
   * `react-markdown`, `remark-gfm` and the `highlight.js` core off it; a policy
   * rendered through `Markdown` puts the lot back — and that component demotes
   * `h1` to `<h3>` because it exists for untrusted agent output.
   */
  check("a document is not rendered through the agent-output pipeline", /Markdown|remark/.test(screen), false);
  /*
   * ⚠ **The URL rules must not reach the prose, and only a bundle can see this.**
   * `router.ts` imports `parseLegalDoc` to parse every URL this app opens, so
   * anything `legal.ts` imports rides the entry chunk. Measured 2026-09-10: entry
   * 365.21 kB (112.01 kB gzipped) with the table there against 308.82 kB (95.68
   * kB) with it in `legal/text.ts`, the documents moving into a `LegalScreen`
   * chunk of 32.57 kB (11.14 kB) that is fetched only when somebody opens one.
   * `typecheck` is blind to it and so is every other assertion here; this line and
   * that module's own docblock are what stand between it and a silent regression.
   */
  const rules = stripComments(readFileSync(new URL("../src/legal.ts", import.meta.url), "utf8"));
  check("the URL rules import no prose", /from "\.\/legal\/(terms|acceptableUse|privacy|text)"/.test(rules), false);
  check("the sweep can see an import of the prose", /from "\.\/(terms|acceptableUse)"/.test('from "./terms"'), true);
  check("nor is the prose", prose.filter((text) => /Markdown|remark/.test(text)), []);
  // Moving between documents replaces, so reading all three leaves no reading
  // history for the phone's own Back to walk.
  check("moving between documents replaces", /navigate\(legalPath\(other\), true\)/.test(screen), true);
  check("and the way out replaces too", /navigate\(up, true\)/.test(screen), true);
  check("nothing formats the date through the reader's locale", /toLocale/.test(screen), false);

  /* ---- the app draws it above every phase, and hands it the way out ---- */

  const app = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  check("the document screen is split off the first-paint path", /import\("\.\/ui\/legal\/LegalScreen"\)/.test(app), true);
  check("it is handed the way out rather than computing one", /up=\{up\}/.test(app), true);
  const drawsLegal = app.indexOf('route.name === "legal"');
  const testsSignedOut = app.indexOf('state.phase === "signed_out"');
  check("the document branch was found", drawsLegal >= 0, true);
  check("and the signed-out branch too", testsSignedOut >= 0, true);
  check("a document answers with no credential, like the gate", drawsLegal < testsSignedOut, true);

  /* ---- the consent box ---- */

  const gate = stripComments(readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8"));
  report("the sign-up form was found", /Create account/.test(gate), `${gate.length} chars after comments`);

  /*
   * ⚠ **`gateOutranksSession`, and this is the assertion that had nothing behind
   * it.** `App.tsx` claimed the predicate *"lives inside `Gate`"*; `Gate` asked
   * `!gateNeedsToken(screen)` instead, so the predicate was a function nothing
   * called and the driver's equality over the two passed because both said the
   * same thing twice.
   */
  check("the signed-in interception asks which screens outrank a session", /!gateOutranksSession\(screen\)/.test(gate), true);
  check("and no longer re-derives it from the token rule", /!gateNeedsToken\(screen\) && state\.phase/.test(gate), false);

  /*
   * ⚠ **The box comes before the button it gates, and this assertion once said the
   * opposite.** It was written under the submit and defended as "a term of the act,
   * beneath the control that performs it" — which reads well and fails on a phone:
   * `ready` is false until the box is ticked, so the button sat disabled with its
   * own precondition below it, and the reason a press did nothing was off the
   * bottom of the reader's attention. Reported from the running screen. It is still
   * not in `GateCard`'s `footer`, which is the one place each screen keeps for the
   * way back. Q3.599.
   */
  const atButton = gate.indexOf("Create account");
  const atConsent = gate.indexOf("I agree to");
  check("the consent box was found", atConsent >= 0, true);
  check("and it comes before the button it gates", atConsent < atButton, true);
  check("inside the form rather than in the card's one place for a way back", /I agree to[\s\S]*<\/form>/.test(gate), true);
  check("and it is not in the footer slot", /footer=\{[\s\S]{0,200}I agree to/.test(gate), false);
  // One screen creates an account, so one screen says what that agrees to.
  check("it is on the one screen that creates an account", (gate.match(/I agree to/g) ?? []).length, 1);

  /*
   * **Every document is named, and named by its own title.** The list comes from
   * `LEGAL_DOCS` and the words from `legalTitle`, so a fourth document appears in
   * this sentence by existing rather than by somebody remembering the line — and
   * a control named one thing pointing at a page titled another is what
   * `sheetUpLabel`'s rule forbids.
   */
  check("the box is built from the list of documents", /LEGAL_DOCS\.map\(/.test(gate), true);
  check("and names them by their own titles", /legalTitle\(doc\)/.test(gate), true);
  check("and addresses them by the path rule", /legalPath\(doc\)/.test(gate), true);
  check("no document title is typed out a second time", LEGAL_DOCS.filter((doc) => gate.includes(legalTitle(doc))), []);

  /*
   * ⚠ **A new tab, because a navigation would lose the form.** Four fields are
   * filled in by this point, two of them passwords, and the tick is state on this
   * component — `navigate` from here unmounts all five. The state cannot go in the
   * address, because the state is a password.
   */
  const consent = gate.slice(gate.lastIndexOf("<label", atConsent), gate.indexOf("</form>", atConsent));
  report("the consent block was sliced out", consent.length > 200 && consent.includes("I agree to"), `${consent.length} chars`);
  /*
   * **One anchor in the source for all three documents**, because the sentence is
   * generated from `LEGAL_DOCS` — which is the property that makes a fourth
   * document appear here by existing. So these count the anchor rather than the
   * documents, and the pair is asserted on it together: a `target` without a
   * `rel` is the half somebody adds back by hand.
   */
  check("there is exactly one anchor, generated for every document", (consent.match(/<a /g) ?? []).length, 1);
  check("it opens in a new tab", (consent.match(/target="_blank"/g) ?? []).length, 1);
  check("with the rel every outbound link in this app carries", (consent.match(/rel="noreferrer"/g) ?? []).length, 1);
  check("and it wears the shared link look", /className=\{LINK\}/.test(consent), true);
  check("and it does not unmount the form", /navigate\(legalPath/.test(consent), false);
  /*
   * **44px, because a mis-tap here decides whether an account is created** —
   * unlike a link inside a sentence, which `web-shell.md` names as owing nothing.
   * `items-start` rather than `items-center`: the label is a sentence that wraps,
   * and centring floats the box to the middle of a three-line paragraph.
   */
  check("the box has a tap strip", /min-h-11/.test(consent), true);
  check("and the box stays on the first line of a wrapping sentence", /items-start/.test(consent), true);

  /*
   * **And it actually gates the form**, positive and negative halves: the clause
   * is in `ready`, and `submit` is unchanged because it already refuses when
   * `ready` is false.
   */
  /*
   * ⚠ **The end anchor searches from the start one, and it did not.** Both
   * declarations live inside `Register`, but `indexOf("const submit")` found the
   * *first* one in the whole file — so the day any earlier component in `Gate.tsx`
   * declared a `submit`, this slice ran backwards, came back empty, and the
   * assertion under it went red about the consent box while the consent box was
   * fine. A reader that fails for a reason it does not name is the shape this
   * file's own header calls crying wolf; passing `start` makes the window
   * `Register`'s own whichever else exist.
   */
  const readyAt = gate.indexOf("const ready");
  const readyBlock = gate.slice(readyAt, gate.indexOf("const submit", readyAt));
  report("the submit predicate was found", readyAt >= 0 && readyBlock.length > 0, `${readyBlock.length} chars`);
  check("the form will not send without the box ticked", /\(!wantsConsent \|\| accepted\);/.test(readyBlock), true);

  /*
   * **Nothing else in the app links a document, and each refusal has its own
   * reason.** `MenuDrawer`'s own docblock sets the test a row must pass — *"it is
   * about **you** rather than about what is on screen"* — and a policy is about the
   * service. (It was `ProfileMenu`'s docblock, and the clause quoted here is one of
   * the two that survived that file being replaced by the drawer intact; the one
   * that did not is named there.) `SignIn`'s two doors are argued at length and its
   * `${LINK}` count is pinned at two one module over. `registrationConfirm` is
   * forbidden a second link by `templates.ts` itself.
   */
  const DOC_LINK = /legalPath\(|href="\/(?:terms|acceptable-use|privacy)"/;
  check("the link sweep can see a document link", DOC_LINK.test('href={legalPath("terms")}'), true);
  for (const [what, where] of [
    ["the menu drawer", "../src/ui/MenuDrawer.tsx"],
    ["the sign-in screen", "../src/ui/SignIn.tsx"],
  ] as const) {
    const text = stripComments(readFileSync(new URL(where, import.meta.url), "utf8"));
    check(`${what} grows no document link`, DOC_LINK.test(text), false);
  }
  const mail = stripComments(
    readFileSync(new URL("../../control-plane/src/mail/templates.ts", import.meta.url), "utf8"),
  );
  check("and no transactional message carries one", /terms|acceptable-use|privacy/.test(mail), false);

  /* ---- and an instance that has not claimed the documents has none of it ---- */

  /*
   * ⚠ **The documents ship in this bundle and name one party, so a deployment
   * has to claim them rather than inherit them.** Three things follow from one
   * flag, and each is asserted from the file that owns it: no page, no box, and
   * nothing sent to a route that would refuse it. This is AGPL software and forks
   * run their own control planes — the failure being pinned is a fork asking its
   * users to agree to a contract with a stranger. Q1.638.
   */
  const { parseInstanceConfig } = await import("../src/instance.js");
  const wire = (documents: unknown): unknown => ({
    registration: { enabled: true, requiresEmail: false },
    mail: { configured: false },
    legal: { documents },
  });
  // `parseInstanceConfig` answers `null` for a body it cannot read at all, and
  // that is a different failure from "did not claim them" — so it is named rather
  // than swallowed by a `?? false` that would make an unparsed body look claimed-free.
  const legalOf = (documents: unknown): unknown => parseInstanceConfig(wire(documents))?.legal ?? "unparsed";
  check("a control plane that claims them is believed", legalOf(true), true);
  check("one that does not is not", legalOf(false), false);
  // Older control planes predate the field entirely; that is the same state.
  check("and one that never heard of the field is not either", legalOf(undefined), false);
  /*
   * Strictly `true`, unlike `catalogue` and `appDownload` beside it, which take
   * any absolute URL. Those two lose a feature when they read wrong; this one
   * decides whether a named party's contract is put in front of somebody.
   */
  for (const truthy of ["true", 1, "yes", {}]) {
    check(`a truthy ${typeof truthy} is not a claim`, legalOf(truthy), false);
  }

  check("the form asks the wire whether anybody is being asked to agree", /state\.config\?\.legal === true/.test(gate), true);
  check("the box is drawn only where it means something", /\{wantsConsent && \(/.test(gate), true);
  check("and the field is sent only there too", /wantsConsent \? \{ acceptedTerms: true \}/.test(gate), true);
  // Both halves: a form that drew no box and sent the field anyway would be
  // claiming somebody agreed to documents this instance does not publish.
  check("nothing sends the field unconditionally", /acceptedTerms: true,\n/.test(gate), false);
  /*
   * ⚠ **Two conditions, and the second is a publication gate rather than a
   * configuration.** `state.config.legal` is whether this deployment *claims* the
   * documents; `legalPublishable()` is whether they are finished. A required
   * `OPERATOR` field still holding `TODO` renders verbatim into the prose — the
   * mail provider is named there as a data *processor* — and the only thing that
   * used to stand between that and a published contract was the `skip` below,
   * which cannot fail a build. Both halves are pinned, because either one alone
   * lets a document through: the claim without the gate publishes a TODO, and the
   * gate without the claim publishes one operator's terms from a fork.
   */
  check(
    "the page is drawn only where the instance claims the documents, and only where they are finished",
    [/if \(state\.config\.legal && legalPublishable\(\)\) \{/.test(app), /legalPublishable/.test(gate)],
    [true, true],
  );
  check("and waits rather than guessing while the wire is unanswered", /if \(state\.config === null\) return <Waiting \/>;/.test(app), true);

  /*
   * ⚠ **No control-plane route was added, and this is what keeps it that way.**
   * `app.get("*")` already serves `index.html` for any extensionless path that is
   * not `/health` or `/v1/*`, so a document is reachable with no credential by
   * *arriving*. A route would have moved three counts nothing else notices —
   * `docs/API.md`'s two and `README.md`'s one — all of which `docscheck` asserts.
   */
  const cpApp = readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8");
  check("the route sweep can see a route", /app\.get\("\/v1\/instance"/.test(cpApp), true);
  check("and the control plane registers none for a document", /app\.(get|post)\("\/(v1\/)?(terms|privacy|legal)/.test(cpApp), false);
  check(
    "no document path looks like an asset to the SPA fallback",
    LEGAL_DOCS.filter((doc) => /\.[a-zA-Z0-9]{1,8}$/.test(doc)),
    [],
  );
}
