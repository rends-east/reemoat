import { readdirSync } from "node:fs";
import { check, report } from "./webcheck.env.js";
import { closure, srcFile, srcFiles, stripComments } from "./webcheck.source.js";

process.stdout.write("\nthe kit: one dropdown, its label outside it, and a panel as wide as the field\n");
{
  const bits = stripComments(srcFile("ui/bits.tsx"));
  const at = bits.indexOf("export function Dropdown");
  const dropdown = at < 0 ? "" : bits.slice(at);
  const types = bits.slice(bits.indexOf("type DropdownTrigger ="), at < 0 ? 0 : at);
  const fieldMember = types.slice(types.indexOf('variant?: "field";'), types.indexOf('variant: "icon";'));
  check("the dropdown and its trigger types were found", [dropdown.length > 0, fieldMember.length > 0], [true, true]);

  // The screenshot that started this: the panel was w-60 under a w-full field, and repeated the field's label as a heading.
  check("a field's panel is exactly its trigger's width", [/"inset-x-0"/.test(dropdown), /\bw-60\b/.test(dropdown)], [true, false]);
  check("a field cannot be given a heading at all", /heading\?: never;/.test(fieldMember), true);
  check("only the icon arm reads one", /const heading = props\.variant === "icon" \? props\.heading : undefined;/.test(dropdown), true);
  check(
    "the trigger is named by its label and then by itself, so the value is in the name",
    /aria-labelledby=\{labelledBy === undefined \? undefined : `\$\{labelledBy\} \$\{triggerId\}`\}/.test(dropdown),
    true,
  );
  check("and the direction is measured at the tap", /setPlacement\(menuPlacement\(triggerRef\.current\)\)/.test(dropdown), true);

  // FIELD and CONTROL are one height written twice, because FIELD's literal is pinned where it is declared.
  const control = /export const CONTROL = "([^"]*)";/.exec(bits)?.[1] ?? "";
  const field = /export const FIELD =\s*"([^"]*)";/.exec(bits)?.[1] ?? "";
  check("CONTROL is FIELD's height, class for class", control.length > 0 && control.split(" ").every((one) => field.split(" ").includes(one)), true);
  const menuRowBody = bits.slice(bits.indexOf("export function menuRow"), bits.indexOf("export const MENU_HEADING"));
  check(
    "and every popover row and field trigger spends it",
    [/\$\{CONTROL\}/.test(menuRowBody), /const FIELD_TRIGGER = `[^`]*\$\{CONTROL\}/.test(bits)],
    [true, true],
  );

  // WebKit does not focus a clicked button, so the element focused at open is the body and focus never came back.
  check("a closing list gives focus back to its trigger, not to whatever held it", /triggerIn\(box\.current, panel\)/.test(bits), true);
}

process.stdout.write("\nthe kit: no platform picker, and a label beside its control rather than around it\n");
{
  const files = srcFiles();
  const native = files.filter((file) => /<select[\s>]/.test(stripComments(srcFile(file))));
  report("there are files to sweep", files.length >= 50, `${files.length} files under src/`);
  check("no screen draws a native select", native, []);

  const kitField = stripComments(srcFile("ui/kit/Field.tsx"));
  const label = /export const FIELD_LABEL = "([^"]*)";/.exec(kitField)?.[1] ?? "";
  check("a field's label is sentence case", [label.length > 0, /uppercase|tracking-wider/.test(label)], [true, false]);
  const opened = kitField.indexOf("<label");
  const closed = kitField.indexOf("</label>");
  const drawn = kitField.indexOf("{children(");
  check("and the control is drawn after the label closes, never inside it", [opened >= 0, closed > opened, drawn > closed], [true, true, true]);
}

process.stdout.write("\nthe kit: what it may reach, and what may reach it\n");
{
  // The gate imports bits; a kit module that pulled in transport would ship it to a page that holds no device key.
  const FORBIDDEN = ["e2ee.ts", "machine.ts", "stream.ts", "daemon.ts", "store.ts", "version.ts"];
  const kit = readdirSync(new URL("../src/ui/kit/", import.meta.url)).filter((name) => /\.tsx?$/.test(name));
  report("the kit has modules to walk", kit.length >= 1, kit.join(", "));
  check(
    "no kit module reaches a transport module or the version constant",
    kit.flatMap((name) => FORBIDDEN.filter((file) => closure(`ui/kit/${name}`, true).has(file)).map((file) => `${name} → ${file}`)),
    [],
  );
  check("and bits imports nothing from the kit, so the two can never load in a cycle", /from "\.\/kit\//.test(srcFile("ui/bits.tsx")), false);
}

process.stdout.write("\nthe kit: a settings screen is groups of kit rows, and says little\n");
{
  const screens = readdirSync(new URL("../src/ui/settings/", import.meta.url))
    .filter((name) => name.endsWith(".tsx"))
    .sort()
    .map((name) => [name, stripComments(srcFile(`ui/settings/${name}`))] as const);
  report("there are settings screens to sweep", screens.length >= 12, `${screens.length} files`);

  // A group per band, never a ruled band per fact (Q3.686).
  check("no settings screen draws a SETTINGS_SECTION band", screens.filter(([, src]) => /\bSETTINGS_SECTION\b/.test(src)).map(([name]) => name), []);

  // A row's kebab is RowMenu's square; a row drawing its own dots is a second menu nothing here asserts.
  const lists = ["InstalledList.tsx", "MarketList.tsx", "PluginSettings.tsx"].map(
    (name) => [name, stripComments(srcFile(`ui/plugins/${name}`))] as const,
  );
  const bits = stripComments(srcFile("ui/bits.tsx"));
  const rowMenu = bits.slice(bits.indexOf("export function RowMenu"), bits.indexOf("export function RowMenu") + 1200);
  check("RowMenu draws the kebab", /as=\{MoreHorizontal\}|icon=\{MoreHorizontal\}/.test(rowMenu), true);
  check(
    "and no settings or plugin-list row draws one of its own",
    [...screens, ...lists].filter(([, src]) => /\bMore(?:Horizontal|Vertical)\b/.test(src)).map(([name]) => name),
    [],
  );

  // A box drawn by hand is a kit entry nobody wrote; the one left is the secret's, which takes a real fill (web-shell.md).
  const HAND_BOX = /rounded-(?:md|lg|xl) border\b|border-edge-strong|min-h-14/;
  const classStrings = (src: string): string[] =>
    [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((hit) => hit[1] ?? hit[2] ?? "");
  check(
    "every box a settings screen draws by hand is named here, by class string",
    [...screens, lists[2] ?? ["PluginSettings.tsx", ""]]
      .map(([name, src]) => [name, classStrings(src).filter((one) => HAND_BOX.test(one)).length] as const)
      .filter(([, n]) => n > 0),
    [["OneTimeSecret.tsx", 1]],
  );

  // Sites, not words: Q3.544 refused a word budget, so a new muted line is a row added to this table on purpose.
  const PROSE = /<p\b[^>]*className=(?:"[^"]*|\{`[^`]*)\btext-(?:muted|faint)\b/g;
  check(
    "every muted paragraph on a settings screen is counted, by file",
    screens.map(([name, src]) => [name, (src.match(PROSE) ?? []).length] as const).filter(([, n]) => n > 0),
    [
      ["AccountSection.tsx", 2],
      ["AgentsPanel.tsx", 5],
      ["EmailSection.tsx", 3],
      ["MachineAgentsSection.tsx", 1],
      ["MachineSection.tsx", 2],
      ["OneTimeSecret.tsx", 1],
      ["Settings.tsx", 1],
    ],
  );
}

process.stdout.write("\nthe kit: pick several is a native box in the palette's ink\n");
{
  const boxes = srcFiles().flatMap((file) =>
    [...stripComments(srcFile(file)).matchAll(/<input\b(?:=>|[^>])*?type="checkbox"(?:=>|[^>])*>/g)].map((hit) => [file, hit[0]] as const),
  );
  report("there are checkboxes to sweep", boxes.length >= 2, `${boxes.length} found`);
  check("every one carries CHECKBOX", boxes.filter(([, tag]) => !/\bCHECKBOX\b/.test(tag)).map(([file]) => file), []);
}
