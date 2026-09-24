import { Check, ChevronDown, ChevronRight, ListFilter, Pencil, Search, Trash2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { rememberPick, rememberRemoval } from "../agentPick";
import { agentPath, navigate, newPath, useOrigin } from "../router";
import { overlayKind, type AgentStep } from "../nav";
import {
  adoptModels,
  allModels,
  choiceRefusal,
  defaultAgentName,
  groupModels,
  harnessRowRefusal,
  hostable,
  listedByBuild,
  searchModels,
  supportingHarnesses,
  unreadSystemsNotice,
  type ModelChoice,
} from "../agents";
import { errorText } from "../http";
import {
  OPENROUTER_SYSTEM_ID,
  fetchOpenRouterModels,
  openRouterNotice,
  type OpenRouterRead,
} from "../openrouter";
import type { MachineId } from "../ids";
import { daemonRead } from "../machine";
import { MACHINE_GONE } from "../plugins";
import { store } from "../store";
import { AGENT_IDS, type AgentCapabilities, type AgentId, type AgentAvailability, type CustomAgent, type SystemInfo } from "../wire";
import { AgentGlyph } from "./AgentIcons";
import { harnessName } from "./agentCard";
import {
  Button,
  ChoiceRow,
  DangerButton,
  Empty,
  FIELD,
  Icon,
  IconButton,
  Menu,
  MENU_HEADING,
  NotReachable,
  SEARCH_FIELD,
  SETTINGS_HEADING,
  SHEET_FOOT,
  SHEET_SCREEN,
  SHEET_SCROLL,
  Spinner,
  TwoStep,
  menuRow,
} from "./bits";

/**
 * Assembling or editing an agent; the draft lives here because each picker is a route that unmounts.
 * A choice is greyed, never removed, and no picker clears the other's value except onClearHarness.
 */
export function AgentBuilder({
  machineId,
  cwd,
  step,
  preset,
  harness: seed,
}: {
  machineId: MachineId;
  cwd: string | null;
  step: AgentStep | null;
  preset: string | null;
  /** A harness to start from (editing a built-in); never set together with preset. */
  harness: string | null;
}): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, AgentCapabilities> | null>(null);
  const [agents, setAgents] = useState<readonly AgentAvailability[] | null>(null);
  // Seeded once, by the effect below, and only with a harness this machine lists; a re-read must not restore a cleared choice.
  const [harness, setHarness] = useState<AgentId | null>(null);
  const seeded = useRef(false);
  const nameOf = useMemo(() => {
    const byId = new Map((agents ?? []).map((one) => [one.id, one] as const));
    return (id: string): string => harnessName(byId.get(id) ?? { id });
  }, [agents]);
  const harnessRows = useMemo(() => agents ?? AGENT_IDS.map((id) => ({ id })), [agents]);
  const harnessIds = useMemo(() => harnessRows.map((one) => one.id), [harnessRows]);
  const [picked, setPicked] = useState<{ system: string; model: string } | null>(null);
  // Held here, not in the picker, which unmounts; one per system, the newer replacing the older.
  const [typed, setTyped] = useState<readonly { system: string; model: string }[]>([]);
  const [name, setName] = useState("");
  /** Frozen the moment somebody types, so their name is not overwritten by a pick. */
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Kept apart from readFailure: a failed write is retried by its own button, a failed read only by Try again.
  const [writeFailure, setWriteFailure] = useState<string | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  // A counter, not a re-request function, so the request and its cancellation stay written once, in the effect.
  const [attempt, setAttempt] = useState(0);
  // A second counter: re-running the preset read would re-seed the fields over the person's changes.
  const [presetAttempt, setPresetAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [stored, setStored] = useState<CustomAgent | null>(null);
  const [presetGone, setPresetGone] = useState(false);
  const [presetFailure, setPresetFailure] = useState<string | null>(null);

  const daemon = store.daemonFor(machineId);

  // Set on the way in as well as cleared on the way out: StrictMode remounts every component.
  const alive = useRef(true);
  // Also the ◀'s destination: the builder has two ways in, and a save must return where the chevron would.
  const origin = useOrigin();
  const leave = (): string => origin ?? newPath(machineId, cwd ?? undefined);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      inflight.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (daemon === undefined) return;
    let cancelled = false;
    // Separate reads with separate catches, so a slow capabilities read neither delays nor empties the systems list.
    // All go back to pending on a retry.
    setReadFailure(null);
    setSystems(null);
    setCapabilities(null);
    setAgents(null);
    void daemon
      .agents()
      .then((listing) => {
        if (cancelled) return;
        setAgents(listing.agents);
      })
      .catch(() => {
        // Left null, not []: null keeps the built-in fallback and lets a retry still adopt the seeded harness.
      });
    void daemon
      .systems()
      .then((listing) => {
        if (cancelled) return;
        setSystems(listing.systems);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setReadFailure(errorText(cause));
        setSystems([]);
      });
    void daemon
      .agentCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setCapabilities(caps.agents);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setReadFailure(errorText(cause));
        setCapabilities({});
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, attempt]);

  useEffect(() => {
    if (seed === null || agents === null || seeded.current) return;
    seeded.current = true;
    if (agents.some((one) => one.id === seed)) setHarness(seed);
  }, [seed, agents]);

  useEffect(() => {
    if (daemon === undefined || preset === null) return;
    let cancelled = false;
    setPresetGone(false);
    setPresetFailure(null);
    void daemon
      .customAgents()
      .then(({ customAgents }) => {
        if (cancelled) return;
        const row = customAgents.find((one) => one.id === preset) ?? null;
        if (row === null) {
          setPresetGone(true);
          return;
        }
        setStored(row);
        setHarness(row.harness);
        setPicked({ system: row.system, model: row.model });
        setName(row.name);
        setNamed(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPresetFailure(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [daemon, preset, presetAttempt]);

  const openRouterListed = systems?.some((one) => one.id === OPENROUTER_SYSTEM_ID) === true;
  const [orModels, setOrModels] = useState<OpenRouterRead | null>(null);
  useEffect(() => {
    if (!openRouterListed) return;
    let cancelled = false;
    void fetchOpenRouterModels().then((read) => {
      if (!cancelled) setOrModels(read);
    });
    return () => {
      cancelled = true;
    };
  }, [openRouterListed]);

  // The fetched list is substituted into the listing before allModels, so a fetched row is a table row; typed ids join the same way.
  const listed = useMemo(() => {
    if (systems === null) return null;
    const read =
      orModels === null || orModels.kind !== "ok"
        ? systems
        : systems.map((one) =>
            one.id === OPENROUTER_SYSTEM_ID ? { ...one, models: orModels.models } : one,
          );
    return adoptModels(read, typed);
  }, [systems, orModels, typed]);

  const catalogueAsListed = useMemo(
    () =>
      listed === null || capabilities === null
        ? []
        :
          // Third argument: ids the catalogue refused; fourth: the harness, so the order answers this screen's question.
          allModels(listed, capabilities, orModels?.kind === "ok" ? orModels.toolless : [], harness),
    [listed, capabilities, orModels, harness],
  );

  // Adopts a stored pick no list holds, so an edit whose model left the catalogue can still be saved.
  const catalogue = useMemo(() => {
    if (picked === null || listed === null || capabilities === null) return catalogueAsListed;
    const held = catalogueAsListed.some(
      (one) => one.system.id === picked.system && one.modelId === picked.model,
    );
    if (held) return catalogueAsListed;
    const orphan = adoptModels(listed, [picked]);
    if (orphan.every((one, index) => one === listed[index])) return catalogueAsListed;
    return allModels(orphan, capabilities, orModels?.kind === "ok" ? orModels.toolless : [], harness);
  }, [catalogueAsListed, picked, listed, capabilities, orModels, harness]);

  /** Drawn only while the daemon lists OpenRouter, so an older daemon carries no sentence about it. */
  const openRouterLine =
    !openRouterListed
      ? null
      : openRouterNotice(
          orModels,
          systems?.find((one) => one.id === OPENROUTER_SYSTEM_ID)?.displayName ?? "OpenRouter",
        );
  // listed, not systems, so this and the OpenRouter line cannot both fire.
  const unreadLine =
    listed === null ? null : unreadSystemsNotice(listed, capabilities, [OPENROUTER_SYSTEM_ID]);
  const noticeLines = [openRouterLine, unreadLine].filter((one): one is string => one !== null);
  const current: ModelChoice | null =
    picked === null
      ? null
      : (catalogue.find(
          (one) => one.system.id === picked.system && one.modelId === picked.model,
        ) ?? null);

  const routingOf = (id: AgentId | null): AgentCapabilities["routing"] =>
    id === null ? null : (capabilities?.[id]?.routing ?? null);

  const reading = capabilities === null;
  const caps = capabilities ?? {};

  const retryReads = (): void => setAttempt((one) => one + 1);
  // The write outranks the read; a read failure is framed under our own subject, chosen by whether any models arrived.
  const error =
    writeFailure ??
    (readFailure === null
      ? null
      : `${catalogue.length === 0 ? MODELS_UNREAD : SOME_MODELS_UNREAD} ${readFailure}`);

  const conflict = current === null ? null : choiceRefusal(harness, current, routingOf(harness), nameOf);
  const shown = name.trim().length > 0 ? name.trim() : (current?.modelName ?? "");
  const machine = state.machines.find((one) => one.id === machineId) ?? null;

  // No daemon client means the machine left this account: a stated reason, never a permanent spinner.
  if (daemon === undefined || machine === null) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>{MACHINE_GONE}</Empty>
        </div>
      </div>
    );
  }

  // Only while the catalogue is empty, so a reachability flicker never throws away a draft.
  const daemonReach = daemonRead(machine.reach);
  if (catalogue.length === 0 && daemonReach === "asking") {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>Checking whether {machine.name} is reachable…</Empty>
        </div>
      </div>
    );
  }
  if (catalogue.length === 0 && daemonReach === "unreachable") {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty
            failed
            action={
              <Button size="sm" onClick={retryReads}>
                Try again
              </Button>
            }
          >
            <NotReachable
              machine={machine}
              tail={preset === null ? ", so nothing can be assembled on it." : ", so this agent cannot be changed."}
            />
          </Empty>
        </div>
      </div>
    );
  }

  if (preset !== null && presetGone) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty>That agent is not on this machine any more.</Empty>
        </div>
      </div>
    );
  }
  if (preset !== null && presetFailure !== null) {
    return (
      <div className={SHEET_SCREEN}>
        <div className={SHEET_SCROLL}>
          <Empty
            failed
            action={
              <Button
                size="sm"
                onClick={() => {
                  setPresetAttempt((one) => one + 1);
                  retryReads();
                }}
              >
                Try again
              </Button>
            }
          >
            That agent could not be read.
            <span className="mt-1 block text-2xs text-muted">{presetFailure}</span>
          </Empty>
        </div>
      </div>
    );
  }

  // Only the cheap table read gates the screen; with no catalogue yet nothing can be drawn as paired or refused.
  if (systems === null || (preset !== null && stored === null)) {
    return (
      <div className={SHEET_SCREEN}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Waiting>
            {preset !== null && stored === null
              ? "Opening this agent…"
              : "Reading this machine's providers…"}
          </Waiting>
        </div>
      </div>
    );
  }

  // Every address here carries the preset, or an edit silently becomes a new agent.
  // Replace, so a pass through the flow is one history entry.
  const back = (): void => navigate(agentPath(machineId, cwd, null, preset), true);

  if (step === "llm" && reading) {
    return (
      <div className={SHEET_SCREEN}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Waiting>Reading this machine&rsquo;s models…</Waiting>
        </div>
      </div>
    );
  }

  if (step === "llm") {
    return (
      <ModelPicker
        choices={catalogue}
        capabilities={caps}
        harnesses={harnessIds}
        nameOf={nameOf}
        harness={harness}
        routing={routingOf(harness)}
        failure={readFailure}
        onRetry={retryReads}
        onClearHarness={() => {
          setHarness(null);
          back();
        }}
        notice={noticeLines}
        value={picked}
        onPick={(choice) => {
          setPicked({ system: choice.system.id, model: choice.modelId });
          if (!named) setName(defaultAgentName(choice.modelName));
          back();
        }}
        onType={(system, model) =>
          setTyped((was) => [...was.filter((one) => one.system !== system), { system, model }])
        }
      />
    );
  }

  // Waits only over a stored preset: there picked is seeded before the catalogue arrives.
  if (step === "harness" && reading && preset !== null) {
    return (
      <div className={SHEET_SCREEN}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Waiting>Reading this machine&rsquo;s models…</Waiting>
        </div>
      </div>
    );
  }

  if (step === "harness") {
    return (
      <HarnessPicker
        capabilities={caps}
        harnesses={harnessRows}
        nameOf={nameOf}
        current={current}
        value={harness}
        onPick={(next) => {
          setHarness(next);
          back();
        }}
      />
    );
  }

  // All four fields on both paths: an edit is a replace, and the pairing is a fact about the row.
  const save = (): void => {
    if (current === null || harness === null || busy) return;
    setBusy(true);
    setWriteFailure(null);
    const controller = new AbortController();
    inflight.current = controller;
    const body = {
      name: shown,
      harness,
      system: current.system.id,
      model: current.modelId,
    };
    void (preset === null
      ? daemon.addCustomAgent(body, controller.signal)
      : daemon.updateCustomAgent(preset, body, controller.signal)
    )
      .then((result) => {
        if (!alive.current) return;
        // Handed off only for a new row: on an edit it would blank the strip to one tile before the listing answers.
        const out = leave();
        // And only when the way out is the strip: a pick remembered elsewhere would fire on a later visit.
        if (preset === null && overlayKind(out) === "new") {
          rememberPick(machineId, result.customAgent);
        }
        navigate(out, true);
      })
      .catch((cause: unknown) => {
        if (alive.current) setWriteFailure(errorText(cause));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  // No signal: a DELETE landing after this screen is gone is harmless, and it is replay-safe.
  const remove = (): Promise<void> | undefined => {
    if (preset === null) return undefined;
    const going = preset;
    setBusy(true);
    setWriteFailure(null);
    return daemon
      .removeCustomAgent(going)
      .then(() => {
        if (!alive.current) return;
        // Unconditional, unlike the pick: only this hand-off clears the strip's standing pick of a deleted row.
        rememberRemoval(machineId, going);
        navigate(leave(), true);
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  return (
    <div className={SHEET_SCREEN}>
      <div className={SHEET_SCROLL}>
        <NameLine
          value={shown}
          onChange={(next) => {
            setNamed(next.trim().length > 0);
            setName(next.trim());
          }}
        />

        <div className="mt-6 space-y-4">
          {/* Harness first: it needs no capabilities read, so the model read runs under it (Q3.528). */}
          <Field label="Harness" clear={harness === null || busy ? null : () => setHarness(null)}>
            <ChoiceRow
              glyph={harness === null ? emptyGlyph : <AgentGlyph agent={harness} size={18} />}
              title={harness === null ? "Choose" : nameOf(harness)}
              placeholder={harness === null}
              // The refusal on the row it is about, and again at the foot, where it wraps rather than truncates (Q3.497).
              subline={conflict}
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              // Live under the capabilities read when creating; dimmed while reading when editing, since an edit already holds a model.
              disabled={busy || (preset !== null && reading)}
              onClick={() => navigate(agentPath(machineId, cwd, "harness", preset), true)}
            />
          </Field>

          <Field
            label="Model"
            clear={current === null || busy ? null : () => setPicked(null)}
          >
            <ChoiceRow
              glyph={emptyGlyph}
              // Not Choose while reading: on the edit path the stored model is not in the catalogue yet.
              title={reading ? "Reading models…" : (current?.modelName ?? "Choose")}
              placeholder={current === null}
              subline={reading ? "Reading this machine's models…" : (current?.system.displayName ?? null)}
              trailing={<Icon as={ChevronRight} size={16} className="shrink-0 text-faint" />}
              disabled={busy || reading}
              onClick={() => navigate(agentPath(machineId, cwd, "llm", preset), true)}
            />
          </Field>
        </div>

        {/* No credential field on this screen: a keyless routed pair is refused in the harness picker instead. */}

        {stored !== null && (
          <div className="mt-8 border-t border-edge pt-5">
            <p className="text-xs text-muted">
              Chats you started with it are not deleted — the next time one comes back it runs on{" "}
              {nameOf(stored.harness)} with its own model rather than this one.
            </p>
            <TwoStep
              armed={confirming}
              onArm={setConfirming}
              size="md"
              className="mt-3"
              question="Remove it?"
              act={{ label: "Remove", danger: true, icon: Trash2 }}
              disabled={busy}
              onAct={remove}
              onFailure={(cause) => {
                if (!alive.current) return;
                setWriteFailure(errorText(cause));
                setConfirming(false);
              }}
              rest={
                <DangerButton icon={Trash2} disabled={busy} onClick={() => setConfirming(true)}>
                  Remove agent
                </DangerButton>
              }
            />
          </div>
        )}
      </div>

      <div className={SHEET_FOOT}>
        {/* Only news: a refused pairing or a failed request; mounted always so a change is announced. */}
        <span
          role="status"
          aria-live="polite"
          className={`min-w-0 flex-1 text-2xs wrap-anywhere ${error === null ? "text-muted" : "text-danger"}`}
        >
          {error ?? conflict}
        </span>
        {/* Only while the line is the read's failure: writes are retried by their own button. */}
        {writeFailure === null && readFailure !== null && (
          <Button size="sm" onClick={retryReads}>
            Try again
          </Button>
        )}
        <Button
          onClick={save}
          tone="primary"
          disabled={busy || current === null || harness === null || conflict !== null}
        >
          {busy
            ? preset === null
              ? "Adding…"
              : "Saving…"
            : preset === null
              ? "Add agent"
              : "Save agent"}
        </Button>
      </div>
    </div>
  );
}

const emptyGlyph = <span aria-hidden="true" className="block h-[18px] w-[18px]" />;

/** Subject over a failed catalogue read; one constant because the foot bar and the model picker must say the same. */
const MODELS_UNREAD = "This machine's models could not be read.";

const SOME_MODELS_UNREAD = "Some of this machine's models could not be read.";

/** The daemon's name limit, held on the field: the save spawns an agent before it checks the length. */
const MAX_AGENT_NAME_CHARS = 80;

/** The daemon's model id limit, MAX_MODEL_CHARS in src/server.ts; written out because web may not import src. */
const MAX_MODEL_CHARS = 256;

/** A wait with words: Spinner is aria-hidden, and a bare spinner reads as failure. */
function Waiting({ children }: { children: ReactNode }): ReactNode {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <Spinner />
      <span>{children}</span>
    </p>
  );
}

function NameLine({ value, onChange }: { value: string; onChange: (next: string) => void }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement | null>(null);
  // A ref, not state, so Escape can beat the blur that unmounting fires; reset on the way in.
  const abandoned = useRef(false);

  const open = (): void => {
    abandoned.current = false;
    setDraft(value);
    setEditing(true);
  };
  const commit = (): void => {
    setEditing(false);
    if (abandoned.current) return;
    // An unchanged draft is not a rename: reporting it would freeze the name against later model picks.
    if (draft.trim() === value.trim()) return;
    onChange(draft);
  };

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={field}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          // Escape is the field's while it has focus — `isTypingInto` in
          // `overlay.ts` is what keeps it from reaching the sheet and closing it.
          if (event.key === "Escape") {
            abandoned.current = true;
            setEditing(false);
          }
        }}
        aria-label="Agent name"
        maxLength={MAX_AGENT_NAME_CHARS}
        placeholder="New agent"
        className="min-h-11 w-full border-0 bg-transparent p-0 text-center text-base font-semibold outline-none"
      />
    );
  }

  return (
    <div className="flex min-h-11 items-center justify-center gap-1">
      <h2
        className={`min-w-0 truncate pl-6 text-base font-semibold ${value.length === 0 ? "text-muted" : ""}`}
      >
        {value.length === 0 ? "New agent" : value}
      </h2>
      <IconButton icon={Pencil} label="Rename this agent" size="sm" onClick={open} />
    </div>
  );
}

function Field({
  label,
  clear,
  children,
}: {
  label: string;
  // Beside the row, never inside: the row is a button, and a button inside a button breaks.
  clear: (() => void) | null;
  children: ReactNode;
}): ReactNode {
  return (
    <div>
      <div className="flex min-h-6 items-center justify-between gap-2 pb-1.5">
        <h3 className={SETTINGS_HEADING}>{label}</h3>
        {clear !== null && (
          <button
            type="button"
            onClick={clear}
            className="tap press -my-1.5 inline-flex min-h-11 shrink-0 items-center rounded-sm px-2 text-2xs text-muted hover:bg-raised hover:text-fg"
          >
            Clear
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** Written out rather than appended to SETTINGS_HEADING: two text colours at equal specificity leave the winner to emission order. */
const HIDDEN_PROVIDER_HEADING = "text-2xs font-semibold tracking-wider text-faint uppercase";

function ModelPicker({
  nameOf,
  harnesses,
  choices,
  capabilities,
  harness,
  routing,
  failure,
  onRetry,
  onClearHarness,
  notice,
  value,
  onPick,
  onType,
}: {
  choices: readonly ModelChoice[];
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  harness: AgentId | null;
  routing: AgentCapabilities["routing"];
  failure: string | null;
  onRetry: () => void;
  /** Empties the harness and returns: the one exception to no picker clearing the other field, for when every provider is collapsed. */
  onClearHarness: () => void;
  nameOf: (id: string) => string;
  harnesses: readonly string[];
  notice: readonly string[];
  value: { system: string; model: string } | null;
  onPick: (choice: ModelChoice) => void;
  onType: (system: string, model: string) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState<string | null>(null);
  const groups = useMemo(() => groupModels(searchModels(choices, query, system)), [choices, query, system]);
  const systems = useMemo(() => {
    const out: SystemInfo[] = [];
    for (const choice of choices) {
      if (!out.some((one) => one.id === choice.system.id)) out.push(choice.system);
    }
    return out;
  }, [choices]);
  const narrowed = systems.find((one) => one.id === system) ?? null;
  const pickable = useMemo(
    () =>
      groups.reduce(
        (count, group) =>
          count +
          (harness === null || hostable(harness, group.system, routing, nameOf) === null
            ? group.choices.length
            : 0),
        0,
      ),
    [groups, harness, routing, nameOf],
  );
  const wanted = query.trim();

  const nothingHere = (): ReactNode => {
    if (narrowed !== null) {
      return (
        <Empty
          action={
            <Button size="sm" onClick={() => setSystem(null)}>
              Show every provider
            </Button>
          }
        >
          {wanted.length > 0
            ? `No ${narrowed.displayName} model here is called “${wanted}”.`
            : `${narrowed.displayName} has no models on this machine.`}
        </Empty>
      );
    }
    if (wanted.length > 0) {
      return (
        <Empty
          action={
            <Button size="sm" onClick={() => setQuery("")}>
              Clear the search
            </Button>
          }
        >
          {`Nothing here is called “${wanted}”.`}
        </Empty>
      );
    }
    // A failed read is not an empty machine.
    if (failure !== null) {
      return (
        <Empty
          failed
          action={
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {MODELS_UNREAD}
          <span className="mt-1 block text-2xs text-muted">{failure}</span>
        </Empty>
      );
    }
    return <Empty>This machine reports no models.</Empty>;
  };

  return (
    <div className={SHEET_SCREEN}>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2 sm:px-5">
        <SearchBox
          value={query}
          onChange={setQuery}
          label="Search models"
          status={countText(pickable, "model", "models")}
        />
        <Menu
          align="right"
          panelClassName="w-48"
          className="shrink-0"
          trigger={(open, toggle) => (
            <IconButton
              icon={ListFilter}
              label={`Showing ${narrowed?.displayName ?? "every provider"}`}
              size="chip"
              expanded={open}
              onClick={toggle}
              className={system === null && !open ? "" : "bg-raised"}
            />
          )}
        >
          {(close) => (
            <>
              <p className={MENU_HEADING}>Provider</p>
              {[null, ...systems.map((one) => one.id)].map((id) => {
                const label = id === null ? "All" : (systems.find((one) => one.id === id)?.displayName ?? id);
                return (
                  <button
                    key={id ?? "all"}
                    role="menuitem"
                    onClick={() => {
                      setSystem(id);
                      close();
                    }}
                    className={`${menuRow("center")} hover:bg-raised ${
                      id === system ? "font-medium text-fg" : "text-muted"
                    }`}
                  >
                    {/* A reserved slot, so choosing does not shift the labels. */}
                    <span className="inline-flex w-3 shrink-0 justify-center">
                      {id === system && <Icon as={Check} size={12} />}
                    </span>
                    {label}
                  </button>
                );
              })}
            </>
          )}
        </Menu>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 sm:px-5">
        {notice.map((line) => (
          <p key={line} className="mt-2 text-2xs text-faint">
            {line}
          </p>
        ))}
        {groups.length === 0 ? (
          nothingHere()
        ) : harness !== null && pickable === 0 ? (
          // Every provider collapsed under this harness: clearing the harness is the one act guaranteed to bring rows back.
          <Empty
            action={
              <Button size="sm" onClick={onClearHarness}>
                Clear the harness
              </Button>
            }
          >
            Nothing here runs under {nameOf(harness)}.
          </Empty>
        ) : (
          groups.map((group) => {
            // A provider this harness cannot be pointed at collapses to one greyed heading; greying rows would disable nearly all of them (Q3.479).
            const wholeProvider = harness === null ? null : hostable(harness, group.system, routing, nameOf);
            if (wholeProvider !== null) {
              return (
                <section key={group.system.id} className="mt-4 first:mt-2">
                  {groups.length > 1 && (
                    <h2 className={`${HIDDEN_PROVIDER_HEADING} mb-1.5`}>{group.system.displayName}</h2>
                  )}
                  <p className="text-2xs text-faint">
                    {wholeProvider}{" "}
                    {group.choices.length === 1 ? "1 model" : `${group.choices.length} models`} hidden.
                  </p>
                </section>
              );
            }
            // Weighed without the harness; a refusal every row shares is hoisted to one line over the group.
            const build = listedByBuild(group, capabilities, nameOf);
            const sublines = group.choices.map((one) => choiceRefusal(null, one, null));
            const first = sublines[0] ?? null;
            const shared =
              first !== null && group.choices.length > 3 && sublines.every((one) => one === first)
                ? first
                : null;
            return (
            <section key={group.system.id} className="mt-4 first:mt-2">
              {groups.length > 1 && (
                <h2 className={`${SETTINGS_HEADING} mb-1.5`}>{group.system.displayName}</h2>
              )}
              {shared !== null && <p className="mb-1.5 text-2xs text-faint">{shared}</p>}
              {build !== null && <p className="mb-1.5 text-2xs text-faint">{build}</p>}
              <ul className="flex flex-col gap-2">
                {group.choices.map((choice) => {
                  // Weighed against the system only: refusing on the harness here too would leave neither half of a bad pair changeable.
                  const why = choiceRefusal(null, choice, null);
                  return (
                    <li key={`${choice.system.id}:${choice.modelId}`}>
                      <ChoiceRow
                        title={choice.modelName}
                        trailing={
                          <Supports
                            choice={choice}
                            capabilities={capabilities}
                            harnesses={harnesses}
                            nameOf={nameOf}
                          />
                        }
                        subline={
                          shared !== null
                            ? null
                            : (why ?? (groups.length > 1 ? null : group.system.displayName))
                        }
                        selected={
                          value !== null &&
                          value.system === choice.system.id &&
                          value.model === choice.modelId
                        }
                        disabled={why !== null}
                        onClick={() => onPick(choice)}
                      />
                    </li>
                  );
                })}
              </ul>
              {group.system.routable === true && (
                <TypedModel
                  system={group.system}
                  onCommit={(model) => {
                    onType(group.system.id, model);
                    // The row lands in this group, and a search that cannot match
                    // it would hide the thing just typed. A narrowing, not a value.
                    setQuery("");
                  }}
                />
              )}
            </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function HarnessPicker({
  capabilities,
  harnesses,
  current,
  value,
  nameOf,
  onPick,
}: {
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  harnesses: readonly { id: string; label?: string }[];
  current: ModelChoice | null;
  value: AgentId | null;
  nameOf: (id: string) => string;
  onPick: (next: AgentId) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = harnesses.filter(
    (one) =>
      needle.length === 0 ||
      harnessName(one).toLowerCase().includes(needle) ||
      one.id.includes(needle),
  );
  const reported = shown
    .map((one) => ({ id: one.id, said: capabilities[one.id]?.error ?? null }))
    .filter((one): one is { id: string; said: string } => one.said !== null);

  return (
    <div className={SHEET_SCREEN}>
      <div className="flex shrink-0 items-center px-4 pt-4 pb-2 sm:px-5">
        <SearchBox
          value={query}
          onChange={setQuery}
          label="Search harnesses"
          status={countText(shown.length, "harness", "harnesses")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-5 sm:px-5">
        {shown.length === 0 ? (
          <Empty
            action={
              needle.length === 0 ? undefined : (
                <Button size="sm" onClick={() => setQuery("")}>
                  Show all
                </Button>
              )
            }
          >
            {needle.length === 0
              ? "This machine did not name any agents."
              : `Nothing here is called “${query.trim()}”.`}
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((one) => {
              const id = one.id;
              // A harness that could not be asked is not one that refuses, so its error is checked before routing.
              const failed = capabilities[id]?.error ?? null;
              const why =
                failed !== null
                  ? COULD_NOT_ASK
                  : harnessRowRefusal(id, current, capabilities[id]?.routing ?? null);
              return (
                <li key={id}>
                  <ChoiceRow
                    glyph={<AgentGlyph agent={id} size={18} />}
                    title={harnessName(one)}
                    subline={why}
                    selected={id === value}
                    disabled={why !== null}
                    onClick={() => onPick(id)}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {reported.length > 0 && <Reported entries={reported} nameOf={nameOf} />}
      </div>
    </div>
  );
}

/** One sentence for every way the ask can fail; the daemon's own error text never reaches the row. */
const COULD_NOT_ASK = "This machine couldn't check what it can run.";

/** The daemon's raw words, behind a disclosure at the foot rather than as a row's refusal. */
function Reported({
  entries,
  nameOf,
}: {
  entries: readonly { id: string; said: string }[];
  nameOf: (id: string) => string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-edge pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="tap press flex min-h-11 items-center gap-1 text-2xs text-muted hover:text-fg"
      >
        <Icon as={open ? ChevronDown : ChevronRight} size={11} />
        What this machine reported
      </button>
      {open && (
        <div className="space-y-2 pb-1">
          {entries.map((one) => (
            <p key={one.id} className="text-2xs text-faint wrap-anywhere">
              <span className="text-muted">{nameOf(one.id)}</span> — {one.said}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** A model id typed under a routable provider; Escape abandons through a ref so the blur does not commit. */
function TypedModel({ system, onCommit }: { system: SystemInfo; onCommit: (model: string) => void }): ReactNode {
  const [draft, setDraft] = useState("");
  const abandoned = useRef(false);
  const commit = (): void => {
    if (abandoned.current) {
      abandoned.current = false;
      return;
    }
    const id = draft.trim();
    if (id.length === 0) return;
    setDraft("");
    onCommit(id);
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          abandoned.current = true;
          setDraft("");
          event.currentTarget.blur();
        }
      }}
      aria-label={`Type a ${system.displayName} model id`}
      placeholder="Or type a model id"
      maxLength={MAX_MODEL_CHARS}
      className={`${FIELD} mt-2 w-full`}
    />
  );
}

function SearchBox({
  value,
  onChange,
  label,
  status,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  status: string;
}): ReactNode {
  return (
    <div className="relative min-w-0 flex-1">
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
        <Icon as={Search} size={13} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={label}
        className={SEARCH_FIELD}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}

function countText(count: number, one: string, many: string): string {
  if (count === 0) return `No ${many}`;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** Harness glyphs with a hover label on fine pointers; the names as words on coarse pointers or keyboard focus. */
function Supports({
  choice,
  capabilities,
  harnesses,
  nameOf,
}: {
  choice: ModelChoice;
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  harnesses: readonly string[];
  nameOf: (id: string) => string;
}): ReactNode {
  const able = supportingHarnesses(choice, capabilities, harnesses);
  if (able.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={`Supports ${able.map((id) => nameOf(id)).join(", ")}`}
      className="flex shrink-0 items-center gap-1 text-faint"
    >
      <span
        aria-hidden="true"
        className="hidden max-w-32 truncate text-2xs [button:focus-visible_&]:block [@media(pointer:coarse)]:block"
      >
        {able.map((id) => nameOf(id)).join(" · ")}
      </span>
      {able.map((id) => (
        <span
          key={id}
          aria-hidden="true"
          className="group/mark relative inline-flex [button:focus-visible_&]:hidden [@media(pointer:coarse)]:hidden"
        >
          <AgentGlyph agent={id} size={13} />
          <span className="pointer-events-none absolute top-1/2 right-full mr-2 hidden -translate-y-1/2 rounded-md border border-edge bg-surface px-2 py-1 text-2xs whitespace-nowrap text-fg shadow-lg group-hover/mark:block">
            Supports {nameOf(id)}
          </span>
        </span>
      ))}
    </span>
  );
}

