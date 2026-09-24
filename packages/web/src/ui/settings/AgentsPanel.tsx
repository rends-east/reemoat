import { Check, Copy, Download, ExternalLink, LogIn, LogOut, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DaemonClient } from "../../daemon";
import type { CredentialWritten } from "../../wire";
import { ApiError, errorText } from "../../http";
import type { MachineId } from "../../ids";
import { store } from "../../store";
import type {
  AgentAuthInfo,
  AgentAuthListing,
  AgentCredentialSlot,
  AgentId,
  AgentLoginSupport,
  InstallRunView,
} from "../../wire";
import { Badge, Button, DangerButton, Empty, FIELD, Icon, IconButton, Spinner, TwoStep } from "../bits";
import { copyText } from "../clipboard";
import { CommandLine } from "../CommandLine";
import {
  installElapsed,
  installFailure,
  installResult,
  installResultLine,
  installStep,
  keepInstallTail,
  primaryControl,
  rawInstallIsOpen,
} from "../agentInstall";
import { loginOutcome, rawTranscriptIsOpen, readLoginTranscript, type LoginOutcome } from "../login";
import {
  harnessName,
  agentBadge,
  agentStance,
  credentialCaveat,
  credentialLabel,
  dividerWord,
  multiSlotLine,
  signOutSentence,
  stanceLine,
  STALE_READ,
  storedChip,
  tokenBlockFor,
  type AgentStance,
} from "../agentCard";
import { toast } from "../Toast";

function useAgentAuth(machineId: MachineId): {
  listing: AgentAuthListing | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [listing, setListing] = useState<AgentAuthListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A counter rather than a cancelled flag: refresh is called imperatively, so reads overlap and a stale pre-login answer must not win.
  const epoch = useRef(0);

  const refresh = (): void => {
    const mine = (epoch.current += 1);
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setError("That machine is not reachable.");
      setLoading(false);
      return;
    }
    setLoading(true);
    void daemon
      .agentAuth()
      .then((next) => {
        if (mine !== epoch.current) return;
        setListing(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (mine !== epoch.current) return;
        setError(`Couldn't read this machine's agents — ${errorText(cause)}.`);
      })
      .finally(() => {
        if (mine === epoch.current) setLoading(false);
      });
  };

  useEffect(() => {
    refresh();
    return () => {
      epoch.current += 1;
    };
  }, [machineId]);
  return { listing, error, loading, refresh };
}

function statusOf(agent: AgentAuthInfo): { tone: "plain" | "strong"; text: string } | null {
  return agentBadge(
    agentStance(agent.available, agent.loggedIn, agent.login?.blocked, agent.lastStartRefusal != null),
  );
}

function RecheckButton({ onClick, busy }: { onClick: () => void; busy: boolean }): ReactNode {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="tap press -mx-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm px-2 text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-40"
    >
      <Icon as={RefreshCw} size={12} /> {busy ? "Checking…" : "Check again"}
    </button>
  );
}

function StaleNotice(): ReactNode {
  return <p className="text-xs text-muted">{STALE_READ}</p>;
}

export function AgentDetail({
  machineId,
  agentId,
  title,
  keyEnv,
}: {
  machineId: MachineId;
  agentId: AgentId;
  /** The card's heading where the harness name is not what the reader came for, such as a system's name. */
  title?: string;
  /** The one credential this card is about when mounted for a system; the harness-level sentences are then left out. */
  keyEnv?: string | null;
}): ReactNode {
  const { listing, error, loading, refresh } = useAgentAuth(machineId);

  if (loading && listing === null) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Spinner /> Asking that machine…
      </div>
    );
  }
  if (listing === null) {
    return (
      <Empty
        failed
        action={
          <Button size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        {error ?? "Could not read this machine's agents."}
      </Empty>
    );
  }

  const agent = listing.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) return <Empty>This machine doesn't have that agent.</Empty>;

  const status = statusOf(agent);
  // Per agent where the daemon says so; an older daemon sends only the daemon-wide flag.
  const login = agent.login ?? { supported: listing.loginSupported, needsInput: true };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {title ?? harnessName(agent)}
        </span>
        {loading ? (
          <Badge tone="plain">checking…</Badge>
        ) : (
          status !== null && <Badge tone={status.tone}>{status.text}</Badge>
        )}
      </div>

      {error !== null && <StaleNotice />}

      <SignIn
        machineId={machineId}
        agent={agent}
        login={login}
        keyEnv={keyEnv ?? null}
        os={listing.os}
        checking={loading}
        checkFailed={error !== null}
        onChanged={refresh}
      />

      <RecheckButton onClick={refresh} busy={loading} />
    </div>
  );
}

/**
 * Two pure decisions, agentStance and tokenBlockFor, and slots that collapse rather than reorder.
 * The key rows stay drawn while the wizard is open, so a stored key is always removable (Q3.431).
 */
function SignIn({
  machineId,
  agent,
  login,
  keyEnv,
  os,
  checking,
  checkFailed,
  onChanged,
}: {
  machineId: MachineId;
  agent: AgentAuthInfo;
  login: AgentLoginSupport;
  keyEnv: string | null;
  os: string | undefined;
  checking: boolean;
  checkFailed: boolean;
  onChanged: () => void;
}): ReactNode {
  // Opens by itself when this tab has a login running; read in the initialiser, so no frame shows the button.
  const [wizard, setWizard] = useState(() => {
    try {
      return window.sessionStorage.getItem(loginKey(machineId, agent.id)) !== null;
    } catch {
      // Storage disabled. The flow still works; it just will not survive a reload.
      return false;
    }
  });
  const [installing, setInstalling] = useState(() => heldInstall(machineId, agent.id) !== null);
  /** The daemon said it installs nothing. The auth listing does not fold that into installable, so this is the only suppression; it only ever rises. */
  const [noInstallRoute, setNoInstallRoute] = useState(false);
  // Adopt what the daemon is already running: one install run daemon-wide, while the stored id is per tab and per agent.
  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) return;
    // Read before the request, so a pane seeded from storage is told apart from a press made while the read was out.
    const held = heldInstall(machineId, agent.id);
    let cancelled = false;
    void daemon
      .liveInstall()
      .then((live) => {
        if (cancelled) return;
        if (!live.supported) setNoInstallRoute(true);
        const running = live.run;
        if (running !== null && running.agent === agent.id) {
          if (!running.done) {
            rememberInstall(machineId, agent.id, running.installId);
            setInstalling(true);
          }
          return;
        }
        // Nothing running: clear a stored id before the pane polls it, but only if it is still the id read before the request.
        if (held !== null && forgetInstallIf(machineId, agent.id, held)) {
          setInstalling(false);
        }
      })
      .catch(() => {
        // An older daemon's 404 and a dropped request are no evidence, so nothing is adopted or withdrawn.
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, agent.id]);

  // credentials may be missing from a daemon predating the field.
  const all = agent.credentials ?? [];
  // Never narrowed to nothing: a daemon too old to send keyEnv must still show the boxes.
  const scoped = keyEnv === null ? all : all.filter((slot) => slot.envName === keyEnv);
  const slots = scoped.length > 0 ? scoped : all;
  const wholeAgent = slots.length === all.length;
  const stored = slots.filter((slot) => slot.set).length;
  const stance = agentStance(agent.available, agent.loggedIn, login.blocked, agent.lastStartRefusal != null);
  // Two axes: available is the adapter, login.supported the agent's own CLI.
  const canSignIn = login.supported && agent.available;
  const block = tokenBlockFor(stance, stored);
  const canInstall = agent.installable === true && !noInstallRoute;
  const line = wholeAgent ? stanceLine(agent, stance, canSignIn, os, canInstall) : null;
  const signInAbove = canSignIn && stance !== "signed_in";
  const divider = wholeAgent ? dividerWord(stance, signInAbove, block) : null;
  const caveat = wholeAgent ? credentialCaveat(agent.id, canSignIn) : null;
  const choice = wholeAgent ? multiSlotLine(agent, slots.length) : null;

  return (
    <div>
      {line !== null && <p className="text-xs text-muted">{line}</p>}

      {(() => {
        switch (
          primaryControl({
            stance,
            installRunning: installing,
            wizardOpen: wizard,
            installable: canInstall,
            canSignIn,
            // Read loosely on purpose, unlike canInstall: this refusal is a 503 carrying the route's sentence, so offering it costs a clean error.
            canSignOut: login.canSignOut !== false,
          })
        ) {
          case "installing":
            return (
              <InstallPane
                machineId={machineId}
                agent={agent.id}
                displayName={harnessName(agent)}
                available={agent.available}
                checking={checking}
                checkFailed={checkFailed}
                onDone={onChanged}
                onClose={() => {
                  setInstalling(false);
                  onChanged();
                }}
              />
            );
          case "wizard":
            return (
              <LoginWizard
                machineId={machineId}
                agent={agent.id}
                displayName={harnessName(agent)}
                needsInput={login.needsInput}
                loggedIn={agent.loggedIn}
                checking={checking}
                checkFailed={checkFailed}
                onDone={onChanged}
                onClose={() => {
                  setWizard(false);
                  onChanged();
                }}
              />
            );
          case "install":
            return (
              <Button tone="primary" className="mt-2 w-full" onClick={() => setInstalling(true)}>
                <Icon as={Download} size={14} />
                Install {harnessName(agent)}
              </Button>
            );
          case "sign_out":
            return <SignOutButton machineId={machineId} agent={agent} onChanged={onChanged} />;
          case "sign_in":
            return (
              <Button tone="primary" className="mt-2 w-full" onClick={() => setWizard(true)}>
                <Icon as={LogIn} size={14} />
                Sign in to {harnessName(agent)}
              </Button>
            );
          case "none":
            return stance === "signed_in" ? (
              <p className="mt-2 text-xs text-muted">{signOutSentence(agent.id, stored)}</p>
            ) : null;
        }
      })()}

      {wholeAgent && stance === "start_refused" && (
        <Button
          className="mt-2 w-full"
          onClick={() => {
            const daemon = store.daemonFor(machineId);
            if (daemon === undefined) {
              toast("error", "That machine is not reachable.");
              return;
            }
            void daemon
              .recheckAgent(agent.id)
              .catch((cause: unknown) =>
                toast("error", `Couldn't ask ${harnessName(agent)} again — ${errorText(cause)}.`),
              )
              .finally(onChanged);
          }}
        >
          Check again
        </Button>
      )}

      {divider !== null && (
        <div className="mt-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-edge" />
          <span className="shrink-0 text-2xs text-muted">{divider}</span>
          <span className="h-px flex-1 bg-edge" />
        </div>
      )}

      {block !== "hidden" && (
        <>
          {block === "editable" && choice !== null && (
            <p className="mt-2 text-xs text-muted">{choice}</p>
          )}
          {slots.map((slot) => (
            <CredentialSlot
              key={slot.envName}
              machineId={machineId}
              agent={agent}
              slot={slot}
              stance={stance}
              caveat={caveat}
              howTo={
                login.blocked === "interactive_pty" && slot.envName === "CLAUDE_CODE_OAUTH_TOKEN"
                  ? "claude setup-token"
                  : null
              }
              editable={block === "editable"}
              onChanged={onChanged}
            />
          ))}
        </>
      )}
    </div>
  );
}


/** Two taps, danger on the first, Cancel last: a second tap on the centred pair lands in the gap or on Cancel, never on the act. */
function SignOutButton({
  machineId,
  agent,
  onChanged,
}: {
  machineId: MachineId;
  agent: AgentAuthInfo;
  onChanged: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const daemon = store.daemonFor(machineId);

  const run = (): Promise<void> | undefined => {
    if (daemon === undefined) return undefined;
    return daemon.signOut(agent.id).then(onChanged);
  };

  return (
    <TwoStep
      armed={confirming}
      onArm={setConfirming}
      align="center"
      size="md"
      className="mt-2"
      question={<>Sign {harnessName(agent)} out on this machine?</>}
      act={{ label: "Sign out", danger: true, icon: LogOut }}
      disabled={daemon === undefined}
      onAct={run}
      onFailure={(cause) => toast("error", `Couldn't sign ${harnessName(agent)} out — ${errorText(cause)}.`)}
      rest={
        <DangerButton icon={LogOut} onClick={() => setConfirming(true)}>
          Sign out
        </DangerButton>
      }
    />
  );
}

/** One saved key, named by what it is; the raw variable name survives only as a title and the wire key (Q3.431). */
function CredentialSlot({
  machineId,
  agent,
  slot,
  stance,
  caveat,
  howTo,
  editable,
  onChanged,
}: {
  machineId: MachineId;
  agent: { id: string; label?: string };
  slot: AgentCredentialSlot;
  stance: AgentStance;
  caveat: string | null;
  howTo: string | null;
  editable: boolean;
  onChanged: () => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const label = credentialLabel(slot.envName);

  const withDaemon = (
    run: (daemon: DaemonClient) => Promise<CredentialWritten>,
    removing = false,
  ): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      toast("error", "That machine is not reachable.");
      return;
    }
    setBusy(true);
    void run(daemon)
      .then((answer) => {
        setValue("");
        // Open chats on this machine are relaunched with the change, since a credential reaches an agent only at spawn.
        toast("ok", credentialToast(removing, answer.restarting));
        onChanged();
      })
      .catch((cause: unknown) =>
        toast(
          "error",
          `Couldn't ${removing ? "remove" : "save"} the ${label.name} — ${errorText(cause)}.`,
        ),
      )
      .finally(() => setBusy(false));
  };

  // Exactly MAX_CREDENTIAL_CHARS in src/server.ts: a lower bound would refuse a key the daemon accepts.
  const tooLong = value.length > 8192;
  const canSave = !busy && value.trim().length > 0 && !tooLong;
  const save = (): void => {
    if (!canSave) return;
    withDaemon((daemon) => daemon.saveCredential(agent.id, slot.envName, value));
  };
  const remove = (
    <IconButton
      icon={X}
      tone="destructive"
      // chip, not lg: a fixed 44px box would stretch this row past the CommandLine box above.
      size="chip"
      className="ml-1"
      label={`Remove ${label.name}`}
      onClick={() => withDaemon((daemon) => daemon.clearCredential(agent.id, slot.envName), true)}
      disabled={busy}
    />
  );

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fg" title={slot.envName}>
          {label.name}
        </span>
        {slot.set && (
          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted">
            <Icon as={Check} size={11} /> {storedChip(agent, stance)}
          </span>
        )}
      </div>
      <p className="text-2xs text-muted">{label.note}</p>

      {howTo !== null && editable && <CommandLine command={howTo} />}

      {editable && caveat !== null && <p className="mt-1 text-xs text-fg">{caveat}</p>}

      {editable ? (
        <>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              // Plain text, not a password field, so no browser offers an account password here.
              type="text"
              name="reemoat-agent-key"
              data-1p-ignore=""
              data-lpignore="true"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              placeholder={slot.set ? "paste a new key" : "paste the key"}
              aria-label={label.name}
              className={`${FIELD} min-w-0 flex-1 font-mono`}
            />
            <Button
              size="sm"
              type="submit"
              className="min-w-20 [@media(pointer:coarse)]:min-h-11"
              disabled={!canSave}
            >
              {busy ? <Spinner /> : "Save"}
            </Button>
            {slot.set && remove}
          </form>
          {tooLong && <p className="mt-1 text-xs text-danger">That&apos;s too long to be a key.</p>}
        </>
      ) : (
        // Nothing typed here can help, but a saved key must stay removable.
        slot.set && <div className="mt-1 flex justify-end">{remove}</div>
      )}
    </div>
  );
}

/** The poll cadence for both flows. Two loops rather than one hook: a vanished login restarts, a vanished install never does. */
const POLL_MS = 700;

function loginKey(machineId: MachineId, agent: string): string {
  return `reemoat.login.${machineId}.${agent}`;
}

/** A separate prefix: login and install ids are different id spaces with different cancel routes. */
function installKey(machineId: MachineId, agent: string): string {
  return `reemoat.install.${machineId}.${agent}`;
}

function heldInstall(machineId: MachineId, agent: string): string | null {
  try {
    return window.sessionStorage.getItem(installKey(machineId, agent));
  } catch {
    // Private mode, or storage disabled. Only reattachment is lost.
    return null;
  }
}

function rememberInstall(machineId: MachineId, agent: string, installId: string): void {
  try {
    window.sessionStorage.setItem(installKey(machineId, agent), installId);
  } catch {
    // As above: the run is live either way, it just will not reattach.
  }
}

function forgetInstall(machineId: MachineId, agent: string): void {
  try {
    window.sessionStorage.removeItem(installKey(machineId, agent));
  } catch {
    // As above; nothing was stored, so there is nothing to remove.
  }
}

/** Clears only if the key still names this run: several writers share the slot, so a blind clear can drop a live run's id. */
function forgetInstallIf(machineId: MachineId, agent: string, installId: string | null): boolean {
  if (heldInstall(machineId, agent) !== installId) return false;
  forgetInstall(machineId, agent);
  return true;
}

/** Unanswered install POSTs by key, so a StrictMode remount or a double tap joins one POST instead of meeting install_busy. */
const pendingInstalls = new Map<string, Promise<InstallRunView>>();

function startInstall(
  daemon: DaemonClient,
  machineId: MachineId,
  agent: string,
): Promise<InstallRunView> {
  const key = installKey(machineId, agent);
  const inFlight = pendingInstalls.get(key);
  if (inFlight !== undefined) return inFlight;
  const started = daemon.startInstall(agent).finally(() => {
    pendingInstalls.delete(key);
  });
  pendingInstalls.set(key, started);
  return started;
}

/** A retrying state is not a failure: only a give-up is drawn red, carried as a field rather than read off the text. */
interface Trouble {
  text: string;
  retrying: boolean;
}

function LoginWizard({
  machineId,
  agent,
  displayName,
  needsInput,
  loggedIn,
  checking,
  checkFailed,
  onClose,
  onDone,
}: {
  machineId: MachineId;
  /** The id string, not the object: it is an effect dependency, and a new object would restart the login. */
  agent: string;
  displayName: string;
  needsInput: boolean;
  loggedIn: boolean | null | undefined;
  checking: boolean;
  checkFailed: boolean;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const [attempt, setAttempt] = useState(0);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [done, setDone] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const paneRef = useRef<HTMLPreElement | null>(null);
  // A ref kept out of the deps: listing onDone would restart the login on every render.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setTrouble({ text: "That machine is not reachable.", retrying: false });
      return;
    }

    const storageKey = loginKey(machineId, agent);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id: string | null = null;
    let cursor = 0;
    let failures = 0;
    const MAX_FAILURES = 5;
    // Restarts of a vanished run are bounded, or a daemon that keeps superseding it spawns ptys forever.
    let restarts = 0;
    const MAX_RESTARTS = 3;

    const finish = (): void => {
      setDone(true);
      onDoneRef.current();
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // Private mode, or storage disabled. Only reattachment is lost.
      }
    };

    const poll = (): void => {
      if (cancelled || id === null) return;
      void daemon
        .readLogin(id, cursor)
        .then((page) => {
          if (cancelled) return;
          failures = 0;
          setTrouble(null);
          cursor = page.cursor;
          if (page.chunk.length > 0) setOutput((previous) => previous + page.chunk);
          if (page.done) {
            finish();
            return;
          }
          timer = setTimeout(poll, POLL_MS);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          if (ApiError.isApiError(cause) && cause.status === 404) {
            try {
              window.sessionStorage.removeItem(storageKey);
            } catch {
              // As above.
            }
            id = null;
            if (restarts >= MAX_RESTARTS) {
              setTrouble({
                text: "That machine keeps stopping this sign-in. Try again in a moment.",
                retrying: false,
              });
              return;
            }
            restarts += 1;
            begin();
            return;
          }
          failures += 1;
          // Lost contact is a different channel from the program's own message, and retrying is decided on the same line that reschedules.
          setTrouble(
            failures < MAX_FAILURES
              ? { text: "Lost contact with that machine. Still trying…", retrying: true }
              : {
                  text: "Cannot reach that machine — the sign-in may still be running.",
                  retrying: false,
                },
          );
          if (failures < MAX_FAILURES) timer = setTimeout(poll, POLL_MS * failures);
        });
    };

    const adopt = (runId: string): void => {
      id = runId;
      setLoginId(runId);
      try {
        window.sessionStorage.setItem(storageKey, runId);
      } catch {
        // As above: the flow still works, it just will not survive a reload.
      }
      poll();
    };

    const begin = (): void => {
      void daemon
        .startLogin(agent)
        .then((run) => {
          if (cancelled) {
            // Started and abandoned in one tick: cancel it rather than leave a pty waiting out its TTL.
            void daemon.cancelLogin(run.loginId).catch(() => {});
            return;
          }
          adopt(run.loginId);
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setTrouble({ text: `Couldn't start the sign-in — ${errorText(cause)}.`, retrying: false });
          }
        });
    };

    let existing: string | null = null;
    try {
      existing = window.sessionStorage.getItem(storageKey);
    } catch {
      // As above.
    }

    // Reattach from cursor 0, which replays the whole transcript the daemon holds.
    if (existing !== null) adopt(existing);
    else begin();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [machineId, agent, attempt]);

  const retry = (): void => {
    setOutput("");
    setDone(false);
    setLoginId(null);
    setTrouble(null);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    const pane = paneRef.current;
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  }, [output]);

  const send = (): void => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined || loginId === null || sending) return;
    const text = input;
    // Emptied only once the daemon confirms, since a device code is unrecoverable if it evaporates; one send at a time.
    setSending(true);
    void daemon
      .writeLogin(loginId, text)
      .then(() => setInput(""))
      .catch((cause: unknown) => toast("error", `Couldn't send that — ${errorText(cause)}.`))
      .finally(() => setSending(false));
  };

  const close = (cancel: boolean): void => {
    const daemon = store.daemonFor(machineId);
    if (cancel && daemon !== undefined && loginId !== null) {
      void daemon.cancelLogin(loginId).catch(() => {});
    }
    try {
      window.sessionStorage.removeItem(loginKey(machineId, agent));
    } catch {
      // Nothing to do — the run expires on its own.
    }
    onClose();
  };

  const view = readLoginTranscript(output, done, needsInput);
  const outcome: LoginOutcome | null =
    view.phase === "done" ? loginOutcome(checking, checkFailed, loggedIn) : null;

  // Step numbers count the blocks actually drawn, each gated by the same const that counts it, and are dropped when only one is drawn.
  const { url, code } = view;
  const showPage = url !== null;
  const showCode = code !== null;
  const showInput = needsInput && !done;
  const steps = { page: showPage, code: showCode, input: showInput };
  const order: (keyof typeof steps)[] = ["page", "code", "input"];
  const stepLabel = (which: keyof typeof steps, imperative: string): string => {
    const drawn = order.filter((key) => steps[key]);
    const at = drawn.indexOf(which);
    if (drawn.length < 2 || at < 0) return imperative;
    return `Step ${at + 1} — ${imperative}`;
  };

  return (
    <div className="mt-2 space-y-2">
      {trouble !== null && (
        <p className={`text-xs ${trouble.retrying ? "text-muted" : "text-danger"}`}>
          {trouble.text}
        </p>
      )}
      {view.message !== null && (
        <p className={`text-xs ${view.phase === "failed" ? "text-danger" : "text-fg font-medium"}`}>
          {view.message}
        </p>
      )}

      {view.phase === "starting" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> starting {agent}'s sign-in…
        </p>
      )}

      {showPage && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="tap press flex min-h-11 items-center gap-2 rounded-md border border-edge-strong bg-surface px-3 text-sm font-medium text-fg hover:bg-raised"
        >
          <Icon as={ExternalLink} size={14} />
          {stepLabel("page", "Open the sign-in page")}
        </a>
      )}

      {showCode && (
        <div className="rounded-md border border-edge bg-raised p-3">
          <div className="text-2xs text-muted">{stepLabel("code", "enter this code there")}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-lg tracking-widest">
              {code}
            </code>
            <IconButton icon={Copy} label="Copy the code" size="lg" onClick={() => copy(code)} />
          </div>
        </div>
      )}

      {(view.phase === "acting" || view.phase === "waiting") && (
        <p className="text-xs text-muted">You can leave this page.</p>
      )}

      {view.phase === "waiting" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> Waiting for you to finish on that page…
        </p>
      )}

      {outcome === "checking" && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> Checking with your machine…
        </p>
      )}
      {outcome === "signedIn" && (
        <p className="flex items-center gap-1.5 text-xs text-fg">
          <Icon as={Check} size={14} /> Signed in to {displayName}.
        </p>
      )}
      {outcome === "notSignedIn" && (
        <p className="text-xs text-fg">That didn&apos;t sign {displayName} in. Try again.</p>
      )}
      {outcome === "cannotTell" && (
        <p className="text-xs text-muted">Finished — start a chat to check.</p>
      )}
      {outcome === "unreachable" && (
        <p className="text-xs text-danger">Couldn&apos;t reach that machine to check whether it worked.</p>
      )}

      {showInput && (
        <div>
          <label className="text-2xs text-muted" htmlFor={`login-${agent}`}>
            {stepLabel("input", "paste the code from that page")}
          </label>
          <div className="mt-1 flex gap-3">
          <input
            id={`login-${agent}`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                send();
              }
            }}
            disabled={loginId === null}
            className={`${FIELD} min-w-0 flex-1 font-mono disabled:opacity-40`}
          />
          <Button onClick={send} disabled={loginId === null || sending}>
            {sending ? <Spinner /> : "Send"}
          </Button>
          </div>
        </div>
      )}

      <details open={rawTranscriptIsOpen(view, outcome)}>
        <summary className="tap list-none text-2xs text-muted hover:text-fg">
          Show terminal output
        </summary>
        <pre
          ref={paneRef}
          className="mt-1 max-h-56 overflow-auto rounded-sm bg-surface p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80"
        >
          {output.length === 0 ? "starting…" : output}
        </pre>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        {outcome === "notSignedIn" && (
          <Button tone="primary" onClick={retry}>
            Try again
          </Button>
        )}
        {outcome === "unreachable" && <Button onClick={onDone}>Check again</Button>}
        <Button tone="ghost" onClick={() => close(!done)}>
          {done ? "Close" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

function InstallPane({
  machineId,
  agent,
  displayName,
  available,
  checking,
  checkFailed,
  onDone,
  onClose,
}: {
  machineId: MachineId;
  agent: string;
  displayName: string;
  available: boolean;
  checking: boolean;
  checkFailed: boolean;
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const [run, setRun] = useState<InstallRunView | null>(null);
  const [output, setOutput] = useState("");
  const [gap, setGap] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [now, setNow] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const daemon = store.daemonFor(machineId);
    if (daemon === undefined) {
      setTrouble({ text: "That machine is not reachable.", retrying: false });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let id: string | null = null;
    let cursor = 0;
    let failures = 0;
    const MAX_FAILURES = 5;
    let text = "";
    let seen = false;

    const poll = (): void => {
      if (cancelled || id === null) return;
      void daemon
        .readInstall(id, cursor)
        .then((chunk) => {
          if (cancelled) return;
          failures = 0;
          seen = true;
          setTrouble(null);
          cursor = chunk.cursor;
          if (chunk.chunk.length > 0) {
            const grown = text + chunk.chunk;
            text = keepInstallTail(grown);
            if (text.length < grown.length) setGap(true);
            setOutput(text);
          }
          if (chunk.gap) setGap(true);
          setRun(chunk);
          if (chunk.done) {
            onDoneRef.current();
            forgetInstallIf(machineId, agent, id);
            return;
          }
          timer = setTimeout(poll, POLL_MS);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // A vanished install is never restarted: a second npm install could race the first.
          if (ApiError.isApiError(cause) && cause.status === 404) {
            forgetInstallIf(machineId, agent, id);
            id = null;
            // A run this pane never saw a byte of hands the slot back to the Install button rather than reporting a loss.
            if (!seen) {
              onCloseRef.current();
              return;
            }
            onDoneRef.current();
            setTrouble({ text: `That machine stopped reporting the install.`, retrying: false });
            return;
          }
          failures += 1;
          setTrouble({ text: errorText(cause), retrying: failures < MAX_FAILURES });
          if (failures < MAX_FAILURES) timer = setTimeout(poll, POLL_MS * failures);
        });
    };

    const follow = (installId: string): void => {
      id = installId;
      poll();
    };

    const start = (): void => {
      void startInstall(daemon, machineId, agent)
        .then((view) => {
          // Written down before the cancelled test, so a pane closed before the POST answered still leaves the id to adopt.
          rememberInstall(machineId, agent, view.installId);
          if (cancelled) return;
          setRun(view);
          follow(view.installId);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setTrouble({ text: `Couldn't start the install — ${errorText(cause)}.`, retrying: false });
        });
    };

    const held = heldInstall(machineId, agent);
    if (held !== null) {
      follow(held);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    // Ask the daemon what it is already running before starting; only an unfinished run of this agent is adopted.
    void daemon
      .liveInstall()
      .then((live) => {
        if (cancelled) return;
        const running = live.run;
        if (running !== null && running.agent === agent && !running.done) {
          rememberInstall(machineId, agent, running.installId);
          setRun(running);
          follow(running.installId);
          return;
        }
        start();
      })
      .catch(() => {
        if (!cancelled) start();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [machineId, agent]);

  const running = run !== null && !run.done;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [running]);

  const result = run?.done === true ? installResult(checking, checkFailed, available) : null;
  const failure = run?.done === true ? installFailure(run.outcome, displayName) : null;
  const elapsed = run === null ? null : installElapsed(run.startedAt, now);
  const step = installStep(run?.phase ?? null);

  return (
    <div className="mt-2">
      {running && (
        <>
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner />
            <span className="min-w-0 flex-1 truncate">
              {step ?? `Installing ${displayName}…`}
              {elapsed === null ? "" : ` · ${elapsed}`}
            </span>
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            {step ?? `Installing ${displayName}`}
          </p>
        </>
      )}
      {failure !== null && <p className="mt-2 text-xs wrap-anywhere text-danger">{failure}</p>}
      {result !== null && failure === null && (
        <p className={`mt-2 text-xs ${result === "unreachable" ? "text-danger" : "text-muted"}`}>
          {result === "checking" ? (
            <span className="flex items-center gap-2">
              <Spinner /> Checking with your machine…
            </span>
          ) : (
            installResultLine(result, displayName)
          )}
        </p>
      )}
      {trouble !== null && (
        <p className={`mt-2 text-xs ${trouble.retrying ? "text-muted" : "text-danger"}`}>
          {trouble.retrying ? `${trouble.text} — still trying` : trouble.text}
        </p>
      )}
      {output.length > 0 && (
        <details className="mt-2" open={rawInstallIsOpen(run)}>
          <summary className="tap list-none text-2xs text-muted hover:text-fg">
            What the installer said
          </summary>
          {gap && (
            <p className="mt-1 text-2xs text-muted">Some earlier output was dropped.</p>
          )}
          <pre className="mt-1 max-h-56 overflow-auto rounded-sm bg-surface p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere text-fg/80">
            {output}
          </pre>
        </details>
      )}
      <div className="mt-2 flex justify-end gap-2">
        {running && (
          <Button
            tone="ghost"
            onClick={() => {
              const daemon = store.daemonFor(machineId);
              const id = run?.installId;
              if (daemon === undefined || id === undefined) return;
              void daemon
                .cancelInstall(id)
                .catch((cause: unknown) => setTrouble({ text: errorText(cause), retrying: false }));
            }}
          >
            Stop
          </Button>
        )}
        <Button tone="ghost" onClick={onClose}>
          {running ? "Hide" : "Close"}
        </Button>
      </div>
    </div>
  );
}

// copyText, since the clipboard API is absent on a plain-http origin; both outcomes are toasted.
function copy(text: string): void {
  void copyText(text).then((ok) => {
    toast(ok ? "ok" : "error", ok ? "code copied" : "could not copy — select it by hand");
  });
}



/** undefined is not zero: a daemon predating the relaunch omits the count. A removal's tail says the chats restart without the key. */
export function credentialToast(removing: boolean, restarting: number | undefined): string {
  const head = removing ? "Removed." : "Saved.";
  const quiet = removing ? head : `${head} Checking whether it works…`;
  if (restarting === undefined) return quiet;
  if (restarting === 0) return quiet;
  const chats = restarting === 1 ? "1 chat is" : `${restarting} chats are`;
  return `${head} ${chats} restarting ${removing ? "without it" : "to pick it up"}.`;
}
