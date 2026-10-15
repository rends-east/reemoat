import { ArrowUp, BookOpen, FileCode2, ListTodo, MoreVertical, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { boardAgentHome, type BoardAgentFound } from "../../boardAgent";
import { errorText } from "../../http";
import { keyOf, type MachineId } from "../../ids";
import { shouldSend } from "../../keys";
import { boardConfigPath, navigate, type BoardPane } from "../../router";
import { machinesAsDrawn, store, type AppState } from "../../store";
import { AgentMark } from "../AgentIcons";
import { fitToContent } from "../autosize";
import { Button, COLUMN, DangerButton, Icon, IconButton, LINK, Menu, menuRow, nicknameLine, Spinner } from "../bits";
import { VERBATIM_FIELD } from "../composing";
import { holdDraft } from "../Composer";
import { Header } from "../Header";
import { Group } from "../kit/List";
import { BOARD_DOCS_URL } from "../links";
import { LAYER, useDismissible } from "../overlay";
import { PaneHandle } from "../PaneHandle";
import { SessionView } from "../SessionView";
import { TASK_PANEL_GUTTER, TASK_PANEL_INSET, TASK_PANEL_WIDTH } from "../TaskPanel";
import { taskPane } from "../taskWidth";
import { assignedOf, recallBoardAgent, refOfAgent, startConfigAgent, useBoardAgent } from "./BoardAgent";
import { BoardEditor } from "./BoardEditor";
import { AssigneeDropdown, useAgentChoices, type Assigned, type AgentChoices } from "./Pickers";
import { useBoard } from "./useBoard";

const TITLE = <span className="truncate text-sm font-semibold">Edit board</span>;

/** What a board is, said wherever @config has nothing in its conversation yet, with the guide (Q3.743). */
function BoardIntro({ children }: { children?: ReactNode }): ReactNode {
  return (
    <>
      <h2 className="text-base font-semibold text-balance">Describe how your tasks should move</h2>
      <p className="text-sm text-muted">
        Your board is one YAML document all your machines share. @config writes it for you.{" "}
        <a className={LINK} href={BOARD_DOCS_URL} target="_blank" rel="noreferrer">
          Read the guide
        </a>
      </p>
      {children}
    </>
  );
}

// One element: it rides down into the transcript's list.
const EMPTY_CONVERSATION = (
  <div className="flex flex-col gap-2 px-2 pt-6 pb-2">
    <BoardIntro />
  </div>
);

/**
 * Edit board is the config agent's conversation (Q3.743): its history and its composer under a header of its own, the YAML
 * docked beside it, and starting it over a screen of its own. With no conversation yet the screen says what a board is, and the
 * first message starts one on the agent its chip names.
 */
export function BoardChat({ state, pane }: { state: AppState; pane: BoardPane }): ReactNode {
  const { configured } = useBoard();
  const { copies, found, settled, reload } = useBoardAgent(state);
  const choices = useAgentChoices(state, null);
  const names = new Map(machinesAsDrawn(state).map(({ machine, name }) => [machine.id, name]));
  const nameOf = (id: MachineId): string => names.get(id) ?? "another machine";
  const readOnly = configured.size === 0;
  const startable = copies.filter((copy) => copy.kind === "known").map((copy) => copy.machineId);
  const home = boardAgentHome(state.localMachineId, startable);
  const remembered = found === null ? recallBoardAgent() : null;
  const away =
    remembered !== null && !copies.some((copy) => copy.machineId === remembered.machineId && copy.kind === "known") ? remembered : null;
  const ref = found === null ? null : refOfAgent(found);
  const row = ref === null ? undefined : state.rowsByKey.get(keyOf(ref));

  // Its conversation is in no list, so a machine that has not listed it yet is handed the copy this screen read.
  useEffect(() => {
    if (found !== null && ref !== null && !store.getSnapshot().rowsByKey.has(keyOf(ref))) store.applySnapshot(ref, found.session);
  }, [found?.machineId, found?.session.id]);

  const yaml = pane === "yaml";
  const closeYaml = useCallback(() => navigate(boardConfigPath()), []);
  const toggleYaml = (): void => navigate(boardConfigPath(yaml ? "chat" : "yaml"));
  // Background tasks docks where the YAML does: opening it closes the YAML.
  const onOpenTasks = useCallback(() => {
    if (yaml) navigate(boardConfigPath());
  }, [yaml]);

  const agentLine = (who: BoardAgentFound): ReactNode => {
    const assigned = assignedOf(who.machineId, who.session);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{nicknameLine(who.session) ?? "@config"}</span>
        <span className="shrink-0 text-faint">·</span>
        <span aria-hidden="true" className="flex shrink-0">
          <AgentMark agent={who.session.agent} />
        </span>
        <span className="truncate">
          {labelOf(choices, assigned) ?? who.session.agent} on {nameOf(who.machineId)}
        </span>
      </span>
    );
  };
  const actions = (openTasks: (() => void) | null): ReactNode => (
    <BoardActions yaml={yaml} onYaml={toggleYaml} onOpenTasks={openTasks} canStartOver={!readOnly && (found !== null || away !== null)} />
  );

  if (pane === "start-over") {
    return <StartOver state={state} found={found} choices={choices} fallback={fallbackOf(choices, home)} onStarted={reload} />;
  }

  const panel = yaml ? <YamlPanel state={state} onClose={closeYaml} /> : null;

  if (found !== null && ref !== null && row !== undefined) {
    return (
      <>
        <SessionView
          state={state}
          sessionRef={ref}
          chrome={{ title: TITLE, subtitle: agentLine(found), actions: (openTasks) => actions(openTasks), docked: yaml, onOpenTasks, empty: EMPTY_CONVERSATION }}
        />
        {panel}
      </>
    );
  }

  const finding = !readOnly && (!settled || found !== null);
  const subtitle = finding || readOnly ? undefined : away !== null ? `@config · on ${nameOf(away.machineId)}, offline` : undefined;
  return (
    <>
      <div className={`flex min-h-0 flex-1 flex-col bg-surface ${yaml ? TASK_PANEL_GUTTER : ""}`}>
        <Header title={TITLE} subtitle={subtitle} close board>
          {actions(null)}
        </Header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Where the conversation's own account of a board stands, so the first message moves nothing. */}
          <div className={`${COLUMN} flex flex-col gap-2 px-6 pt-6 pb-8`}>
            {readOnly ? (
              <p className="text-sm text-muted">No machine runs the configurable board yet.</p>
            ) : finding ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Spinner />
                Finding @config…
              </p>
            ) : away !== null ? (
              <>
                <h2 className="text-base font-semibold text-balance">
                  @config is on {nameOf(away.machineId)}, which is offline
                </h2>
                <p className="text-sm text-muted">The conversation comes back when {nameOf(away.machineId)} does.</p>
                <span className="mt-2 flex">
                  <Button onClick={() => navigate(boardConfigPath("start-over"))}>
                    <Icon as={RotateCcw} size={13} />
                    Start over here…
                  </Button>
                </span>
              </>
            ) : (
              <BoardIntro>{home === null && <p className="text-sm text-muted">No machine that runs the board is online.</p>}</BoardIntro>
            )}
          </div>
        </div>
        {!readOnly && (
          <FirstMessage
            state={state}
            fallback={fallbackOf(choices, home)}
            disabled={finding || away !== null || home === null}
            onStarted={reload}
          />
        )}
      </div>
      {panel}
    </>
  );
}

function fallbackOf(choices: AgentChoices, home: MachineId | null): Assigned | null {
  return home === null ? null : (choices.offers.get(home)?.agents[0] ?? null);
}

function labelOf(choices: AgentChoices, who: Assigned): string | null {
  return choices.offers.get(who.machineId)?.agents.find((one) => one.kind === who.kind && one.id === who.id)?.label ?? null;
}

function BoardActions({
  yaml,
  onYaml,
  onOpenTasks,
  canStartOver,
}: {
  yaml: boolean;
  onYaml: () => void;
  onOpenTasks: (() => void) | null;
  canStartOver: boolean;
}): ReactNode {
  const item = `${menuRow("center")} text-fg hover:bg-raised`;
  return (
    <>
      <Button size="sm" tone={yaml ? "plain" : "ghost"} onClick={onYaml}>
        <Icon as={FileCode2} size={14} />
        YAML
      </Button>
      <Menu
        align="right"
        panelClassName="w-56"
        className="shrink-0"
        trigger={(open, toggle) => (
          <IconButton icon={MoreVertical} label="Edit board actions" size="lg" expanded={open} haspopup="menu" onClick={toggle} />
        )}
      >
        {(close) => (
          <>
            <a role="menuitem" className={item} href={BOARD_DOCS_URL} target="_blank" rel="noreferrer" onClick={close}>
              <Icon as={BookOpen} size={14} />
              Read the guide
            </a>
            {onOpenTasks !== null && (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  close();
                  onOpenTasks();
                }}
              >
                <Icon as={ListTodo} size={14} />
                Background tasks
              </button>
            )}
            {canStartOver && (
              <>
                <div role="separator" className="my-1 border-t border-edge" />
                <button
                  type="button"
                  role="menuitem"
                  className={`${menuRow("center")} text-danger hover:bg-raised`}
                  onClick={() => {
                    close();
                    navigate(boardConfigPath("start-over"));
                  }}
                >
                  <Icon as={RotateCcw} size={14} />
                  Start over…
                </button>
              </>
            )}
          </>
        )}
      </Menu>
    </>
  );
}

/**
 * The composer before there is a conversation: the first message starts the config agent on the agent its chip names, then goes
 * to it as any message does. Nothing typed is lost to a refusal: a start refused leaves it here, a send refused hands it to the
 * conversation's own box.
 */
function FirstMessage({
  state,
  fallback,
  disabled,
  onStarted,
}: {
  state: AppState;
  fallback: Assigned | null;
  disabled: boolean;
  onStarted: () => void;
}): ReactNode {
  const [text, setText] = useState("");
  const [pick, setPick] = useState<Assigned | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const chosen = pick ?? fallback;
  const sendable = !disabled && !busy && chosen !== null && text.trim().length > 0;

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!sendable || chosen === null) return;
    const body = text;
    setBusy(true);
    setError(null);
    void startConfigAgent(chosen, false, null)
      .then(async (ref) => {
        const daemon = store.daemonFor(ref.machineId);
        try {
          if (daemon === undefined) throw new Error("That machine is not connected right now.");
          const result = await daemon.prompt(ref.sessionId, body);
          store.applySnapshot(ref, result.session);
        } catch (cause) {
          holdDraft(keyOf(ref), body);
          throw cause;
        } finally {
          onStarted();
        }
      })
      .then(() => setText(""))
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="pb-safe sticky bottom-0 bg-surface pt-1.5">
      <div className={`${COLUMN} px-4 pb-2`}>
        <form onSubmit={submit} className="relative rounded-xl border border-edge-strong bg-surface px-1.5 pt-1 pb-1.5">
          <textarea
            {...VERBATIM_FIELD}
            ref={area}
            value={text}
            disabled={disabled || busy}
            onChange={(event) => {
              setText(event.target.value);
              fitToContent(event.target);
            }}
            onKeyDown={(event) => {
              const key = { ...event, isComposing: event.nativeEvent.isComposing };
              if (!shouldSend(key) || window.matchMedia("(pointer: coarse)").matches) return;
              event.preventDefault();
              submit();
            }}
            rows={1}
            enterKeyHint="enter"
            placeholder="What should change?"
            aria-label="Message to @config"
            className="no-focus-ring block min-h-11 w-full resize-none overflow-hidden bg-transparent px-2 py-2.5 text-sm outline-none"
          />
          <div className="mt-1.5 flex items-center gap-2 sm:gap-3">
            <AssigneeDropdown
              state={state}
              value={chosen}
              harness={null}
              disabled={disabled || busy}
              onChange={(next) => {
                if (next !== "nobody" && next !== "you") setPick(next);
              }}
              shape={{ variant: "chip", label: "Agent" }}
            />
            <span className="ml-auto flex shrink-0 items-center pl-1">
              {busy ? (
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand text-on-brand">
                  <Spinner />
                </span>
              ) : (
                <IconButton icon={ArrowUp} label="Send" tone="primary" size="chip" shape="round" type="submit" disabled={!sendable} />
              )}
            </span>
          </div>
        </form>
        {error !== null && <p className="px-2 pt-1.5 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

/** The YAML beside the conversation from md, docked where Background tasks docks; below md the whole screen. */
function YamlPanel({ state, onClose }: { state: AppState; onClose: () => void }): ReactNode {
  useDismissible("menu", onClose, true);
  return createPortal(
    <>
      <aside
        aria-label="Board YAML"
        className={`fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-surface ${TASK_PANEL_WIDTH} ${TASK_PANEL_INSET} md:left-auto md:rounded-2xl md:border md:border-edge md:shadow-lg ${LAYER.overlay}`}
      >
        <BoardEditor state={state} onClose={onClose} />
      </aside>
      <PaneHandle
        pane={taskPane}
        label="YAML panel width"
        sign={-1}
        className={`fixed hidden w-2 translate-x-1/2 md:top-6 md:bottom-6 md:[@media(pointer:fine)]:block ${LAYER.overlay}`}
        style={{ right: "calc(var(--task-fit) + 0.75rem)" }}
      />
    </>,
    document.body,
  );
}

/** Starting over, a screen of its own: the agent and machine it starts on, and what ends (Q3.743). */
function StartOver({
  state,
  found,
  choices,
  fallback,
  onStarted,
}: {
  state: AppState;
  found: BoardAgentFound | null;
  choices: AgentChoices;
  fallback: Assigned | null;
  onStarted: () => void;
}): ReactNode {
  const [pick, setPick] = useState<Assigned | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = pick ?? (found !== null ? assignedOf(found.machineId, found.session) : fallback);
  const confirm = (): void => {
    if (chosen === null || busy) return;
    setBusy(true);
    setError(null);
    void startConfigAgent(chosen, true, found)
      .then(() => {
        onStarted();
        navigate(boardConfigPath());
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };
  const labelled = chosen === null ? null : (labelOf(choices, chosen) ?? chosen.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <Header title={<span className="truncate text-sm font-semibold">Start over</span>} close board back={{ to: boardConfigPath(), label: "Back to Edit board" }} />
      <div className="w-full overflow-y-auto px-4 pt-1 pb-10 lg:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <Group error={error}>
            <AssigneeDropdown
              state={state}
              value={chosen}
              harness={found?.session.agent ?? null}
              busy={busy}
              onChange={(next) => {
                if (next !== "nobody" && next !== "you") setPick(next);
              }}
              shape={{ variant: "row", title: "Agent" }}
            />
          </Group>
          <p className="text-sm text-muted">
            {labelled === null ? "This conversation ends; the board keeps what it has." : `This conversation ends, and @config starts again with ${labelled}. The board keeps what it has.`}
          </p>
          <span className="flex">
            <DangerButton icon={RotateCcw} disabled={chosen === null || busy} onClick={confirm}>
              {busy ? <Spinner /> : "Start over"}
            </DangerButton>
          </span>
        </div>
      </div>
    </div>
  );
}
