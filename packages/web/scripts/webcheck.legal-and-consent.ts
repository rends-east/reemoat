import { readFileSync } from "node:fs";

import { check, report, skip } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

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

  check("there are documents to have checked", LEGAL_DOCS.length, 3);
  check("no segments is no document", parseLegalDoc([]), null);
  check("an unrelated path is none", parseLegalDoc(["settings"]), null);
  check("and the case it arrives in does not decide", parseLegalDoc(["Terms"]), null);
  check("whole segments only, the isOverlayPath rule", isLegalPath("/termsish"), false);
  check("and a real one is a document path", isLegalPath("/terms"), true);
  for (const doc of LEGAL_DOCS) {
    check(`${doc} names itself`, parseLegalDoc([doc]), doc);
    check(`${doc} round-trips through its own path`, parseLegalDoc(legalPath(doc).slice(1).split("/")), doc);
  }
  check("the acronym stays in the address", legalTitle("acceptable-use"), "Acceptable Use Policy");
  check("and no title is just the address back", LEGAL_DOCS.filter((doc) => legalTitle(doc) === doc), []);

  // The gate is parsed first, so a document named like a gate screen would lose to it silently.
  check("no document collides with a gate screen", LEGAL_DOCS.filter((doc) => isGatePath(legalPath(doc))), []);
  check(
    "and no gate screen collides with a document",
    GATE_SCREENS.filter((screen) => isLegalPath(gatePath(screen))),
    [],
  );

  // isSheet and isOverlayPath are not exhaustive switches, so a new route reaches them with no compile error.
  const asRoute = { name: "legal", doc: "terms" } as const;
  check("a document is one level in, like a session", depthOf(asRoute as never), 1);
  check("it is not a pop-up, asked from the route", isSheet(asRoute as never), false);
  check("nor from its own path", isOverlayPath(legalPath("terms")), false);
  check("so no sheet owns it", sheetKind(asRoute as never), null);
  check("and no panel head names it", sheetTitle(asRoute as never), null);
  // The way out is never null: LegalScreen draws its control only where there is somewhere to go.
  check("the way out of a document is the root", upFrom(asRoute as never, "/", null), "/");
  check("and never nothing", upFrom(asRoute as never, "/", null) !== null, true);
  check(
    "the control names where it goes rather than saying Back",
    [legalUpLabel(false), legalUpLabel(true)],
    ["Back to sign in", "Back to your machines"],
  );

  const docs = LEGAL_DOCS.map((doc) => legalDocument(doc));
  const textOf = (block: (typeof docs)[number]["sections"][number]["blocks"][number]): string =>
    block.kind === "list" ? block.items.join(" ") : block.text;

  check("only the languages that exist are offered", [...LEGAL_LANGS], ["en"]);
  check("every document is filed under its own key", docs.filter((one, at) => one.doc !== LEGAL_DOCS[at]), []);
  check("and every one of them is in the language it claims", docs.filter((one) => one.lang !== "en"), []);
  // A floor, since a sweep over an empty table passes silently (Q5.114).
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

  // CC BY 4.0 requires the credit where the work is read, so every field of it is asserted.
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
  // Pinned rather than derived, or the data would be asserted against itself.
  check(
    "each document names the licences it is actually under",
    LEGAL_DOCS.map((doc) =>
      legalDocument(doc)
        .credits.map((credit) => credit.licence)
        .sort(),
    ),
    [["CC BY 4.0"], ["CC BY 4.0", "CC0 1.0"], ["CC BY 4.0"]],
  );

  const unfilled = operatorIncomplete();
  if (unfilled.length > 0) {
    skip("the operator's own details are filled in", `${unfilled.join(", ")} still placeholder`);
  } else {
    check("the operator's own details are filled in", unfilled, []);
  }
  check("the contact address is one", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(OPERATOR.email), true);
  // A skip exits 0, so legalPublishable is what keeps an unfinished document unpublished.
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

  // The prose carries no link of its own: the only outbound URLs are the credits'.
  const allowed = new Set(docs.flatMap((one) => one.credits.flatMap((c) => [c.workUrl, c.licenceUrl])));
  // Raw source on purpose: stripComments would remove every URL, since each contains //.
  const found = new Set(proseRaw.flatMap((text) => [...text.matchAll(/https:\/\/[^"'\s)]+/g)].map((m) => m[0])));
  report("the URL sweep can see a URL", found.size > 0, `${found.size} distinct`);
  check("and every one of them is a credit's", [...found].filter((url) => !allowed.has(url)), []);

  const screen = stripComments(readFileSync(new URL("../src/ui/legal/LegalScreen.tsx", import.meta.url), "utf8"));
  report("the document page was found", screen.length > 600, `${screen.length} chars after comments`);
  check("a document is set at the reading measure", /\$\{COLUMN\}/.test(screen), true);
  check("and never at the form measure", /max-w-sm/.test(screen), false);
  check("nor at a measure of its own", /max-w-\[/.test(screen), false);
  check("nor at a size off the scale", /text-\[/.test(screen), false);
  check(
    "the column states the body size and a paragraph inherits it",
    [/\$\{COLUMN\} px-4 py-8 text-sm/.test(screen), /className="mt-3">\{block\.text\}/.test(screen)],
    [true, true],
  );
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
  check("there is one page shell", (screen.match(/min-h-full/g) ?? []).length, 1);
  // The agent-output Markdown pipeline stays off the sign-in path's bundle.
  check("a document is not rendered through the agent-output pipeline", /Markdown|remark/.test(screen), false);
  // router.ts pulls legal.ts into the entry chunk, so it must not import the prose; typecheck cannot see this.
  const rules = stripComments(readFileSync(new URL("../src/legal.ts", import.meta.url), "utf8"));
  check("the URL rules import no prose", /from "\.\/legal\/(terms|acceptableUse|privacy|text)"/.test(rules), false);
  check("the sweep can see an import of the prose", /from "\.\/(terms|acceptableUse)"/.test('from "./terms"'), true);
  check("nor is the prose", prose.filter((text) => /Markdown|remark/.test(text)), []);
  // Moving between documents replaces, so reading all three leaves no reading
  // history for the phone's own Back to walk.
  check("moving between documents replaces", /navigate\(legalPath\(other\), true\)/.test(screen), true);
  check("and the way out replaces too", /navigate\(up, true\)/.test(screen), true);
  check("nothing formats the date through the reader's locale", /toLocale/.test(screen), false);

  const app = stripComments(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"));
  check("the document screen is split off the first-paint path", /import\("\.\/ui\/legal\/LegalScreen"\)/.test(app), true);
  check("it is handed the way out rather than computing one", /up=\{up\}/.test(app), true);
  const drawsLegal = app.indexOf('route.name === "legal"');
  const testsSignedOut = app.indexOf('state.phase === "signed_out"');
  check("the document branch was found", drawsLegal >= 0, true);
  check("and the signed-out branch too", testsSignedOut >= 0, true);
  check("a document answers with no credential, like the gate", drawsLegal < testsSignedOut, true);

  const gate = stripComments(readFileSync(new URL("../src/ui/gate/Gate.tsx", import.meta.url), "utf8"));
  report("the sign-up form was found", /Create account/.test(gate), `${gate.length} chars after comments`);

  check("the signed-in interception asks which screens outrank a session", /!gateOutranksSession\(screen\)/.test(gate), true);
  check("and no longer re-derives it from the token rule", /!gateNeedsToken\(screen\) && state\.phase/.test(gate), false);

  // The box comes before the button it gates, or a disabled button hides its precondition below it (Q3.599).
  const atButton = gate.indexOf("Create account");
  const atConsent = gate.indexOf("I agree to");
  check("the consent box was found", atConsent >= 0, true);
  check("and it comes before the button it gates", atConsent < atButton, true);
  check("inside the form rather than in the card's one place for a way back", /I agree to[\s\S]*<\/form>/.test(gate), true);
  check("and it is not in the footer slot", /footer=\{[\s\S]{0,200}I agree to/.test(gate), false);
  check("it is on the one screen that creates an account", (gate.match(/I agree to/g) ?? []).length, 1);

  check("the box is built from the list of documents", /LEGAL_DOCS\.map\(/.test(gate), true);
  check("and names them by their own titles", /legalTitle\(doc\)/.test(gate), true);
  check("and addresses them by the path rule", /legalPath\(doc\)/.test(gate), true);
  check("no document title is typed out a second time", LEGAL_DOCS.filter((doc) => gate.includes(legalTitle(doc))), []);

  // A new tab: navigating away would unmount a half-filled form holding passwords.
  const consent = gate.slice(gate.lastIndexOf("<label", atConsent), gate.indexOf("</form>", atConsent));
  report("the consent block was sliced out", consent.length > 200 && consent.includes("I agree to"), `${consent.length} chars`);
  check("there is exactly one anchor, generated for every document", (consent.match(/<a /g) ?? []).length, 1);
  check("it opens in a new tab", (consent.match(/target="_blank"/g) ?? []).length, 1);
  check("with the rel every outbound link in this app carries", (consent.match(/rel="noreferrer"/g) ?? []).length, 1);
  check("and it wears the shared link look", /className=\{LINK\}/.test(consent), true);
  check("and it does not unmount the form", /navigate\(legalPath/.test(consent), false);
  check("the box has a tap strip", /min-h-11/.test(consent), true);
  check("and the box stays on the first line of a wrapping sentence", /items-start/.test(consent), true);

  // The end anchor searches from the start one, so an earlier submit elsewhere in the file cannot invert the slice.
  const readyAt = gate.indexOf("const ready");
  const readyBlock = gate.slice(readyAt, gate.indexOf("const submit", readyAt));
  report("the submit predicate was found", readyAt >= 0 && readyBlock.length > 0, `${readyBlock.length} chars`);
  check("the form will not send without the box ticked", /\(!wantsConsent \|\| accepted\);/.test(readyBlock), true);

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

  // Forks run their own control planes, so an instance must claim the documents rather than inherit them (Q1.638).
  const { parseInstanceConfig } = await import("../src/instance.js");
  const wire = (documents: unknown): unknown => ({
    registration: { enabled: true, requiresEmail: false },
    mail: { configured: false },
    legal: { documents },
  });
  // An unreadable body is a different failure, so it is named rather than read as unclaimed.
  const legalOf = (documents: unknown): unknown => parseInstanceConfig(wire(documents))?.legal ?? "unparsed";
  check("a control plane that claims them is believed", legalOf(true), true);
  check("one that does not is not", legalOf(false), false);
  // Older control planes predate the field entirely; that is the same state.
  check("and one that never heard of the field is not either", legalOf(undefined), false);
  // Strictly true: this decides whether a named party's contract is put in front of somebody.
  for (const truthy of ["true", 1, "yes", {}]) {
    check(`a truthy ${typeof truthy} is not a claim`, legalOf(truthy), false);
  }

  check("the form asks the wire whether anybody is being asked to agree", /state\.config\?\.legal === true/.test(gate), true);
  check("the box is drawn only where it means something", /\{wantsConsent && \(/.test(gate), true);
  check("and the field is sent only there too", /wantsConsent \? \{ acceptedTerms: true \}/.test(gate), true);
  check("nothing sends the field unconditionally", /acceptedTerms: true,\n/.test(gate), false);
  // Both the claim and legalPublishable are required: either alone publishes an unfinished document or a stranger's terms.
  check(
    "the page is drawn only where the instance claims the documents, and only where they are finished",
    [/if \(state\.config\.legal && legalPublishable\(\)\) \{/.test(app), /legalPublishable/.test(gate)],
    [true, true],
  );
  check("and waits rather than guessing while the wire is unanswered", /if \(state\.config === null\) return <Waiting \/>;/.test(app), true);

  const cpApp = readFileSync(new URL("../../control-plane/src/app.ts", import.meta.url), "utf8");
  check("the route sweep can see a route", /app\.get\("\/v1\/instance"/.test(cpApp), true);
  check("and the control plane registers none for a document", /app\.(get|post)\("\/(v1\/)?(terms|privacy|legal)/.test(cpApp), false);
  check(
    "no document path looks like an asset to the SPA fallback",
    LEGAL_DOCS.filter((doc) => /\.[a-zA-Z0-9]{1,8}$/.test(doc)),
    [],
  );
}
