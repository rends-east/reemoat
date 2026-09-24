/** A barrel for ordering: these ../src bodies evaluate once, here, in this order, and ESM hands each instance to every later importer. */

// Type-only, so erased and never run ahead of the window stub.
import type { NavMove } from "../src/nav.js";
import type { StoredEvent, SystemInfo } from "../src/wire.js";

// Imported for its side effect: the window stubs must exist before any ../src module body runs.
import "./webcheck.env.js";

export type { NavMove, StoredEvent, SystemInfo };

export const { SessionStream } = await import("../src/stream.js");
export const { askedQuestion, permissionLayout, essentialContext, formatLocation, hasInput, optionLabel, permissionButtons, permissionContext, permissionHeadline, planControls, detailContext, readInput, truncationNotice, withheldDetail } = await import(
  "../src/permission.js"
);
export const { changeCounts, diffLines } = await import("../src/diff.js");
export const {
  ATTACH_REPLAY_MAX,
  HISTORY_PAGE,
  MAX_AUTO_HISTORY,
  MAX_HELD_TRANSCRIPTS,
  MAX_TRANSCRIPT_BYTES,
  commandsPlan,
  elapsedSince,
  holdConfig,
  fillWindow,
  gapPlan,
  loadStop,
  localMachineAfter,
  machinesAsDrawn,
  nextCut,
  reattachSince,
  sessionGroups,
  sessionLists,
  unreduceSnapshot,
} = await import("../src/store.js");
export const {
  currentView,
  groupsVersion,
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
  siblingsOf,
  sublineWarns,
  toggleFolder,
  visibleRows,
  waitingFloor,
} = await import("../src/ui/groups.js");
export const { LOCAL_DISPLAY_NAME, MAX_MACHINE_ORDER, dropSlot, machineDisplayName, nextOrder, orderMachines, setMachineOrder } =
  await import("../src/machineOrder.js");
export const { expandConfig, prune, reduceConfig } = await import("../src/configMemory.js");
export const { RANK_STEP, canReorder, compareRows, effectiveRank, orderSessions, rankBetween, resolveDrop } = await import(
  "../src/sessionOrder.js"
);
export const { sessionLabel } = await import("../src/ui/bits.js");
export const { displayCwd, folderLabel } = await import("../src/paths.js");
export const { openableHref } = await import("../src/ui/links.js");
export const {
  chipParts,
  chipValue,
  choiceLabel,
  configProse,
  drawnChoices,
  drawnControls,
  labelFor,
  showsCaption,
  unavailableHint,
  restartsAgent,
  choiceRefusal,
  slotFor,
  splitOptions,
  withChoice,
  effortFollowUp,
} = await import("../src/ui/agentConfig.js");
export const { acceptsMidTurn, canCancelTurn, cancelInFlight, hasLiveAgent, isTerminal, needsHuman, queuedSeqs, showsWorking } =
  await import("../src/wire.js");
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
export const { hugWidth } = await import("../src/ui/hug.js");

export type Stream = InstanceType<typeof SessionStream>;
