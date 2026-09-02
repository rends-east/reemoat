/**
 * Everything this driver pulls out of `packages/web/src`, in one place.
 *
 * It stays a barrel rather than being pushed down into the sections that use
 * each name, and that is not tidiness — it is the ordering. These module bodies
 * evaluate once, here, in this order, exactly as they did when this was the top
 * of one file. At least one section depends on *when* a `../src` module is first
 * evaluated: `webcheck.shell-and-enrollment.ts` imports `router.js` from inside a
 * block that has just rewritten `window.location.pathname`, and ESM hands that
 * same instance to every later importer.
 */

// Type-only, so it is erased outright rather than being a static import running
// ahead of the `window` stub below. The history cases need real `StoredEvent`s:
// `fillWindow` filters and orders them, and a fixture cast to `never` would let
// a shape it cannot actually accept through.
import type { NavMove } from "../src/nav.js";
import type { StoredEvent, SystemInfo } from "../src/wire.js";

// The stubs, before any `../src` module body runs — `machine.ts` computes
// `ROUTE_MODE` from the URL at load time. Importing them for their side effect is
// the ordering pin that statement order used to give for free.
import "./webcheck.env.js";

export type { NavMove, StoredEvent, SystemInfo };

// Dynamic, so the stub above is in place before any module body runs.
export const { SessionStream } = await import("../src/stream.js");
export const { askedQuestion, permissionLayout, essentialContext, formatLocation, hasInput, optionLabel, permissionButtons, permissionContext, permissionHeadline, planControls, detailContext, readInput, withheldDetail } = await import(
  "../src/permission.js"
);
export const { changeCounts, diffLines } = await import("../src/diff.js");
export const {
  ATTACH_REPLAY_MAX,
  HISTORY_PAGE,
  MAX_AUTO_HISTORY,
  // Imported rather than written out as `12`. The bound was restated here as a
  // literal, which makes the assertion one-sided: lowering the cap to 1 still
  // passed, and raising it failed with a message naming no constant.
  MAX_HELD_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  commandsPlan,
  elapsedSince,
  holdConfig,
  fillWindow,
  gapPlan,
  loadStop,
  nextCut,
  reattachSince,
  sessionGroups,
  sessionLists,
} = await import("../src/store.js");
export const {
  currentView,
  folderNames,
  folderPathOf,
  allRows,
  foldersOf,
  machineSubline,
  machineTabs,
  matchesQuery,
  rowSubpath,
  selectMachine,
  selectedMachineIn,
  setQuery,
  sublineWarns,
  toggleFolder,
  visibleRows,
  waitingFloor,
} = await import("../src/ui/groups.js");
export const { sessionLabel } = await import("../src/ui/bits.js");
export const { openableHref } = await import("../src/ui/links.js");
export const {
  chipParts,
  chipReserve,
  chipValue,
  choiceLabel,
  configProse,
  drawnChoices,
  contextHint,
  contextPercent,
  drawnControls,
  labelFor,
  pieLabel,
  pieTone,
  shortCount,
  showsCaption,
  unavailableHint,
  restartsAgent,
  choiceRefusal,
  slotFor,
  splitOptions,
  withChoice,
} = await import("../src/ui/agentConfig.js");
export const { canCancelTurn, cancelInFlight, hasLiveAgent, isTerminal, showsWorking } = await import("../src/wire.js");
export const {
  TRANSCRIPT_SILENT,
  buildTail,
  mergeUpdates,
  placeNodes,
  resolveTool,
  opensToAnything,
  permissionDecisions,
  refused,
  restatesInput,
  runSummary,
  foldRuns,
  detailWorthDrawing,
  clipTitle,
  headlineWorthDrawing,
  TITLE_CHARS,
  TITLE_OVERFLOW_MIN,
  SUMMARY_CHARS,
  sameNode,
  showsInTranscript,
  stripFence,
  supersedes,
  toolSummary,
  outstandingTasks,
  stillRunning,
  isDelegation,
  MAX_CHILDREN,
} = await import("../src/ui/tail.js");
export const {
  composerPlaceholder,
  focusWorthKeeping,
  markKeyNav,
  shouldFocusComposer,
  shouldReleaseComposer,
  takeKeyNav,
} = await import(
  "../src/ui/composing.js"
);
export type Stream = InstanceType<typeof SessionStream>;
