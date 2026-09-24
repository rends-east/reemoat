import { check } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { snapshot } from "./webcheck.ws.js";
import { FOOT_EXACT_PX, FOOT_SLACK_PX, followsAfterScroll, gapBelow, wheelLeavesFoot } from "./webcheck.modules.js";

process.stdout.write("\nthe conversation leaves its foot only when the reader takes it away\n");
{
  const foot = { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 };
  check("the gap is what lies below the box", [gapBelow(foot), gapBelow({ ...foot, scrollTop: 1300 })], [0, 100]);
  check("the foot and its slack", [FOOT_EXACT_PX, FOOT_SLACK_PX], [2, 48]);
  // Measured in WebKit: a pin's own scroll event, dispatched after 90px landed in a later task of the same frame, read a 90px gap.
  check("growth landing after a pin is nobody leaving", followsAfterScroll(true, { ...foot, scrollHeight: 2090 }, 1400), true);
  check("however far past the old 48px slack it lands", followsAfterScroll(true, { ...foot, scrollHeight: 2400 }, 1400), true);
  check("a move up off the foot is the reader's", followsAfterScroll(true, { ...foot, scrollTop: 1300 }, 1400), false);
  check("inside the slack as well, or a pin pulls them back while they scroll", followsAfterScroll(true, { ...foot, scrollTop: 1390 }, 1400), false);
  check("but not a sub-pixel settle of the offset under growth", followsAfterScroll(true, { ...foot, scrollTop: 1399.4, scrollHeight: 2090 }, 1400), true);
  check(
    "a clamp moves up and lands on the foot, so it keeps it",
    followsAfterScroll(true, { scrollHeight: 1950, clientHeight: 600, scrollTop: 1350 }, 1400),
    true,
  );
  check("reaching the foot rejoins it, whoever was held away", followsAfterScroll(false, foot, 900), true);
  check("rounding at the foot is the foot", followsAfterScroll(false, { ...foot, scrollTop: 1398.5 }, 1200), true);
  check("moving down into the slack rejoins", followsAfterScroll(false, { ...foot, scrollTop: 1360 }, 1300), true);
  check("moving down short of it does not", followsAfterScroll(false, { ...foot, scrollTop: 1300 }, 1200), false);
  check(
    "and a reader held away stays away while the content grows under them",
    followsAfterScroll(false, { ...foot, scrollTop: 900, scrollHeight: 2400 }, 900),
    false,
  );
  check("a wheel up leaves before its scroll event, a zoom does not", [wheelLeavesFoot(-4, false), wheelLeavesFoot(4, false), wheelLeavesFoot(-4, true)], [true, false, false]);

  const follow = stripComments(srcFile("ui/follow.ts"));
  const everyCommit = /useLayoutEffect\(\(\) => \{([\s\S]*?)\n {2}\}\);/.exec(follow)?.[1] ?? "";
  check(
    "every commit settles before paint, and a send or a switch holds the foot first",
    [everyCommit.includes("sent !== was.sent"), /decide\(true\);[\s\S]*settle\(box\);/.test(everyCommit)],
    [true, true],
  );
  check("one observer watches the box and what is in it", /observer\.observe\(box\);\s*observer\.observe\(content\);/.test(follow), true);
  check(
    "wherever layout is settled a move is judged before the pin, since it can land before its own scroll event",
    /decide\(followsAfterScroll\(atBottomRef\.current, box, lastTop\.current, lastClient\.current\)\);\s*if \(atBottomRef\.current\) box\.scrollTop = box\.scrollHeight;/.test(follow),
    true,
  );
  check("and a send is not judged: it outranks a move not reported yet", /lastTop\.current = box\.scrollTop;\s*decide\(true\);/.test(follow), true);

  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check("the transcript follows through the hook, with sends as its counter", /useFollow\(key, firstSeq, tailRequest\)/.test(view), true);
  check("what is in the box is the element observed", /<div ref=\{contentRef\}>/.test(view), true);
  check("Chrome's anchoring is off, so the history shift is not made twice", /overflow-y-auto \[overflow-anchor:none\]/.test(view), true);
  check("and no scroll event decides from where the box happens to be", /onScroll=|const measure/.test(view), false);
}

process.stdout.write("\nwrapping moves nothing\n");
{
  const fit = stripComments(srcFile("ui/autosize.ts"));
  // Measured in WebKit: collapsed, the box clamped the transcript 16 to 132px off its foot on the keystroke after each wrap.
  check(
    "the composer's parent holds its height while the box collapses to measure",
    /holder\.style\.minHeight = `\$\{holder\.offsetHeight\}px`;[\s\S]*area\.style\.height = "auto";[\s\S]*area\.style\.height = `[\s\S]*holder\.style\.minHeight = "";/.test(fit),
    true,
  );
  const composer = stripComments(srcFile("ui/Composer.tsx"));
  check("and the composer has no second copy", [/import \{ fitToContent \} from "\.\/autosize";/.test(composer), /function fitToContent/.test(composer)], [true, false]);

  const card = stripComments(srcFile("ui/AskCard.tsx"));
  check(
    "the card reports its height before paint, on mount and on every commit",
    [
      /useLayoutEffect\(\(\) => \{\s*const panel = panelRef\.current;\s*if \(panel === null \|\| typeof ResizeObserver/.test(card),
      /useLayoutEffect\(\(\) => \{\s*const panel = panelRef\.current;\s*if \(panel !== null\) heightOut\.current\?\.\(panel\.offsetHeight\);\s*\}\);/.test(card),
    ],
    [true, true],
  );
}

process.stdout.write("\na message sent while the agent talks lands once, and the foot never moves under it\n");
{
  const { claimEcho, echoFor, isEchoOf, sendFloor, setEcho, landEcho } = await import("../src/echo.js");
  const { deliversQueued } = await import("../src/wire.js");
  const { keepsFootSlot } = await import("../src/ui/EventList.js");
  const key = "m/claim" as never;
  const prompt = (seq: number, text: string, uploads: string[] = []) => ({
    seq,
    ts: 0,
    event: {
      type: "prompt" as const,
      text,
      attachments: uploads.map((uploadId) => ({ uploadId, name: uploadId, mime: null, bytes: 1, inlined: false })),
    },
  });
  const sent = { text: "fix it", seq: Number.MAX_SAFE_INTEGER, after: 40, attachments: [] };

  // Measured in WebKit and Chromium: the socket beat the POST, and the message was drawn twice for 4 to 15 frames, then jerked 84-112px.
  check("its own prompt event is recognised before the POST names a seq", isEchoOf(sent, prompt(41, "fix it")), true);
  check(
    "and nothing else is: an earlier prompt, other words, another event",
    [
      isEchoOf(sent, prompt(40, "fix it")),
      isEchoOf(sent, prompt(41, "fix it too")),
      isEchoOf(sent, { seq: 41, ts: 0, event: { type: "text", role: "agent", thought: false, text: "fix it" } }),
    ],
    [false, false, false],
  );
  check("a seq the daemon named bounds it", isEchoOf({ ...sent, seq: 41 }, prompt(42, "fix it")), false);
  const withFiles = { ...sent, attachments: [{ uploadId: "u1", name: "a", mime: null, bytes: 1, inlined: false }] };
  check(
    "files must be the same files, in order",
    [isEchoOf(withFiles, prompt(41, "fix it", ["u1"])), isEchoOf(withFiles, prompt(41, "fix it")), isEchoOf(withFiles, prompt(41, "fix it", ["u2"]))],
    [true, false, false],
  );

  setEcho(key, sent);
  claimEcho(key, [prompt(41, "something else")]);
  check("an unrelated prompt leaves the echo", echoFor(key)?.text, "fix it");
  claimEcho(key, [prompt(41, "fix it")]);
  check("its own takes it in the same commit as the row", echoFor(key), null);

  const landed = { text: "yes", seq: Number.MAX_SAFE_INTEGER, after: 0, attachments: [] };
  setEcho(key, landed);
  check("with nothing held, the floor is the newest seq", sendFloor("m/none" as never, 50), 50);
  check("an unlanded send does not raise it", sendFloor(key, 50), 50);
  landEcho(key, landed, 60);
  check("a landed send whose event is still on the socket does, so the same words sent again are not taken for it", sendFloor(key, 50), 60);

  const store = stripComments(srcFile("store.ts"));
  check("onEvents claims before it settles", /claimEcho\(key, events\);\s*settleEcho\(key,/.test(store), true);
  const composer = stripComments(srcFile("ui/Composer.tsx"));
  check("and the composer's echo carries its floor", /after: sendFloor\(key,/.test(composer), true);

  const between = { ...snapshot, status: "idle", turn: null, queuedPrompts: [{ id: "q_1", seq: 7, at: 0 }] } as never;
  // Measured: the pump fans a turnless snapshot out before it delivers; two socket frames a frame apart blinked the line out and back.
  check("a message about to be handed over is work", deliversQueued(between), true);
  check(
    "and not once something holds it, or the session is ending, or nothing waits",
    [
      deliversQueued({ ...(between as object), pendingPermissions: [{ permissionId: "p" }] } as never),
      deliversQueued({ ...(between as object), status: "stopping" } as never),
      deliversQueued({ ...(between as object), queuedPrompts: [] } as never),
    ],
    [false, false, false],
  );
  const view = stripComments(srcFile("ui/SessionView.tsx"));
  check("the transcript's working line reads it", /showsWorking\(snapshot\) \|\| deliversQueued\(snapshot\)/.test(view), true);

  // Measured: the line leaving at a turn's end moved a pinned conversation 20px down, then the last settled text 22-44px back up.
  const cancelled = { kind: "event", key: "e9", stored: { seq: 9, ts: 0, event: { type: "turn_end", stopReason: "cancelled", usage: null } } } as never;
  const answered = { kind: "event", key: "e8", stored: { seq: 8, ts: 0, event: { type: "prompt", text: "x" } } } as never;
  check("the empty foot keeps the working line's room", keepsFootSlot(0, answered, false), true);
  check("but not under a card, which pads its own foot", keepsFootSlot(120, answered, false), false);
  check("nor under a cancel, which takes that room as the line did (Q3.437)", keepsFootSlot(0, cancelled, false), false);
  check("until something is sent after it", keepsFootSlot(0, cancelled, true), true);
  const list = stripComments(srcFile("ui/EventList.tsx"));
  check(
    "the room is inside the column's own foot, so the line coming and going changes no height",
    [
      /askHeight === 0 \? `calc\(\$\{TRANSCRIPT_FOOT_PX\}px - \$\{FOOT_LINE\}\)`/.test(list),
      /const FOOT_LINE = "1\.25rem";/.test(list),
      /keepsFootSlot\(askHeight, rows\.at\(-1\), echo !== null\) && <div aria-hidden=\{true\} className="h-5" \/>/.test(list),
    ],
    [true, true, true],
  );
}

process.stdout.write("\na window that grows keeps the conversation on its foot, and its offset written through\n");
{
  const { followsAfterScroll, resync, RESIZE_SETTLE_MS } = await import("../src/ui/follow.js");
  // Measured in WebKit, one step of a live resize: the box 4px taller, its offset clamped 4px, and 50px streamed in before a look.
  const step = { scrollTop: 2097, scrollHeight: 2370, clientHeight: 223 };
  check("a clamp the box's own growth explains is layout, whatever streamed in after it", followsAfterScroll(true, step, 2101, 219), true);
  check("while a move past that growth is still the reader's", followsAfterScroll(true, { ...step, scrollTop: 2080 }, 2101, 219), false);
  check("and with the box unchanged, every move up is", followsAfterScroll(true, { ...step, clientHeight: 219 }, 2101, 219), false);
  check("the fourth argument defaults to no growth", followsAfterScroll(true, step, 2101), false);

  const writes: number[] = [];
  const box = (top: number, scrollHeight: number, clientHeight: number) => {
    let at = top;
    return {
      scrollHeight,
      clientHeight,
      get scrollTop() {
        return at;
      },
      set scrollTop(value: number) {
        writes.push(value);
        at = value;
      },
    } as unknown as HTMLElement;
  };
  const pinned = box(2400, 2700, 300);
  resync(pinned);
  check("the offset is written as a change and back, so it cannot be dropped as a no-op", [writes.splice(0), pinned.scrollTop], [[2399, 2400], 2400]);
  const top = box(0, 2700, 300);
  resync(top);
  check("at the very top it steps down rather than up", [writes.splice(0), top.scrollTop], [[1, 0], 0]);
  resync(box(0, 300, 300));
  check("and a box with nothing to scroll is left alone", writes.splice(0), []);
  check("the settle after the window stops", RESIZE_SETTLE_MS, 250);

  const follow = stripComments(srcFile("ui/follow.ts"));
  check(
    "every settle judges against the box's last height, and writes the offset through when that height moved",
    [
      /followsAfterScroll\(atBottomRef\.current, box, lastTop\.current, lastClient\.current\)/.test(follow),
      /if \(box\.clientHeight !== lastClient\.current\) resync\(box\);/.test(follow),
      /lastClient\.current = box\.clientHeight;/.test(follow),
    ],
    [true, true, true],
  );
  check(
    "and once more after the window has stopped resizing",
    /window\.addEventListener\("resize", onResize\)/.test(follow) && /settle\(box\);\s*resync\(box\);\s*\}, RESIZE_SETTLE_MS\)/.test(follow),
    true,
  );
}
