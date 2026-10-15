/** Every machine's tasks and the account's board, gathered by this client itself: no machine is asked about another's, and none is asked through the server (Q3.719). */

import {
  accountBoard,
  boardDue,
  boardSignature,
  boardTasks,
  BOARD_STORAGE_KEY,
  DEFAULT_ACCOUNT_BOARD,
  readBoardDocument,
  readStamp,
  readTask,
  readTasks,
  readTombstones,
  recallAccountBoard,
  recallBoards,
  rememberAccountBoard,
  rememberBoards,
  taskRefKey,
  TASKS_STORAGE_KEY,
  type AccountBoard,
  type Asked,
  type BoardMachine,
  type BoardStamp,
  type BoardTask,
  type HeldBoard,
  type HeldConfig,
} from "./board";
import { meansRouteAbsent } from "./http";
import { keyOf, refOf, sessionId, type MachineId } from "./ids";
import { machinesAsDrawn, store, type AppState } from "./store";
import type { TaskSnapshot } from "./wire";

const TICK_MS = 1_000;

export interface BoardSnapshot {
  tasks: BoardTask[];
  /** Machines whose board has answered at least once since launch; a list drawn before that is this device's memory. */
  read: ReadonlySet<MachineId>;
  /** Machines whose daemon keeps tasks: nothing about a task is offered on one that does not. */
  supported: ReadonlySet<MachineId>;
  /** Machines whose daemon runs the configurable board, with the revision it says it holds. */
  configured: ReadonlyMap<MachineId, BoardStamp>;
  /** Each configured machine's copy of the board, where it has been read. */
  copies: ReadonlyMap<MachineId, HeldConfig>;
  /** The account's board: the newest copy, else what this device last drew, else the default preset. */
  board: AccountBoard;
  /** What a press asked of a task and when, by `taskRefKey`, until its daemon answers (Q3.728). */
  asked: ReadonlyMap<string, Asked>;
  held: ReadonlyMap<MachineId, HeldBoard>;
}

function recall(): Map<MachineId, HeldBoard> {
  try {
    return recallBoards(window.localStorage.getItem(TASKS_STORAGE_KEY));
  } catch {
    // Private mode: nothing is remembered between launches, and the board still reads.
    return new Map();
  }
}

function recallBoard(): AccountBoard {
  try {
    return recallAccountBoard(window.localStorage.getItem(BOARD_STORAGE_KEY));
  } catch {
    // Private mode: the default preset stands until a daemon answers.
    return DEFAULT_ACCOUNT_BOARD;
  }
}

class BoardStore {
  private readonly held = recall();
  private readonly askedAt = new Map<MachineId, number>();
  private readonly asking = new Set<MachineId>();
  private readonly answered = new Set<MachineId>();
  private readonly copies = new Map<MachineId, HeldConfig>();
  private readonly fetchingCopy = new Set<MachineId>();
  private readonly listeners = new Set<() => void>();
  private remembered = recallBoard();
  private watchers = 0;
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private machinesKey = "";
  private drawnKey = "";
  /** What each machine's task sessions were last heard doing, so a change asks that board again at once (Q3.726). */
  private readonly sessionsKey = new Map<MachineId, string>();
  private readonly asked = new Map<string, Asked & { press: number }>();
  private presses = 0;
  private snapshot: BoardSnapshot = {
    tasks: [],
    read: new Set(),
    supported: new Set(),
    configured: new Map(),
    copies: new Map(),
    board: this.remembered,
    asked: new Map(),
    held: new Map(),
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  getSnapshot = (): BoardSnapshot => this.snapshot;

  /** Held while the board itself is on screen: it is then read at the session list's pace. */
  watch = (): (() => void) => {
    this.watchers += 1;
    this.tick();
    return () => {
      this.watchers -= 1;
    };
  };

  /** Asked now, whatever the pace: after a press that changed a board, or on the reader's own pull. */
  refresh(machine: MachineId | null = null): void {
    for (const id of machine === null ? [...this.askedAt.keys()] : [machine]) this.askedAt.delete(id);
    this.tick();
  }

  /** A task as a daemon just answered it, drawn before the next read. */
  apply(machine: MachineId, raw: TaskSnapshot): void {
    const task = readTask(raw);
    if (task === null) return;
    const board = this.held.get(machine);
    const tasks = board === undefined ? [] : board.tasks.filter((one) => one.id !== task.id);
    // A session works on one task: a row this answer moved it to no longer holds it elsewhere.
    const moved = new Set(task.sessions.map((session) => session.id));
    const rest = tasks.map((one) =>
      one.sessions.some((session) => moved.has(session.id))
        ? { ...one, sessions: one.sessions.filter((session) => !moved.has(session.id)) }
        : one,
    );
    this.held.set(machine, {
      tasks: [...rest, task],
      at: Date.now(),
      read: "known",
      daemon: board?.daemon ?? null,
      config: board?.config ?? null,
      tombstones: board?.tombstones ?? [],
    });
    this.publish();
  }

  /** A board a machine just took, drawn before its next read says so. */
  applyBoard(machine: MachineId, copy: HeldConfig): void {
    this.copies.set(machine, copy);
    const held = this.held.get(machine);
    if (held !== undefined) this.held.set(machine, { ...held, config: { revision: copy.revision, hash: copy.hash } });
    this.publish();
  }

  /**
   * Draws a task as a press asked, in a column or with an assignee, until that press is answered, whatever a read in between
   * says; the returned release is called once the answer is applied, or the refusal toasted. A later press on the same task
   * outlives an earlier release.
   */
  hold(machine: MachineId, taskId: string, change: Omit<Asked, "at">): () => void {
    const key = taskRefKey(machine, taskId);
    const press = (this.presses += 1);
    this.asked.set(key, { ...change, at: Date.now(), press });
    this.publish(false);
    return () => {
      if (this.asked.get(key)?.press !== press) return;
      this.asked.delete(key);
      this.publish(false);
    };
  }

  forget(machine: MachineId, taskId: string): void {
    const board = this.held.get(machine);
    if (board === undefined) return;
    this.held.set(machine, { ...board, tasks: board.tasks.filter((one) => one.id !== taskId) });
    this.publish();
  }

  private start(): void {
    this.unsubscribe = store.subscribe(() => this.onApp());
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.onApp();
    this.tick();
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** The app's store fans out on every event; only a machine's name, place or drawn reach redraws the board. */
  private onApp(): void {
    const state = store.getSnapshot();
    // Another account's boards are nobody's here: signed out, or a fleet that was read and does not hold the machine.
    const before = this.held.size;
    for (const id of [...this.held.keys()]) {
      const gone = state.phase === "signed_out" || (state.registry === "known" && !state.machines.some((machine) => machine.id === id));
      if (gone) {
        this.held.delete(id);
        this.copies.delete(id);
      }
    }
    if (this.held.size !== before) {
      this.machinesKey = "";
      this.publish();
    }
    // A turn that ended or a request that came moves a task: its board is read now, not on the next pace.
    let moved = false;
    for (const [machine, board] of this.held) {
      const heard = board.tasks
        .flatMap((task) => task.sessions.map((one) => state.rowsByKey.get(keyOf(refOf(machine, sessionId(one.id))))?.snapshot.status ?? ""))
        .join(",");
      const last = this.sessionsKey.get(machine);
      this.sessionsKey.set(machine, heard);
      if (last !== undefined && last !== heard) {
        this.askedAt.delete(machine);
        moved = true;
      }
    }
    if (moved) this.tick();
    const key = machinesOf(state)
      .map((machine) => `${machine.id}\u0000${machine.name}\u0000${machine.reach}`)
      .join("\u0001");
    if (key === this.machinesKey) return;
    this.machinesKey = key;
    this.publish(false);
  }

  private tick(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    const state = store.getSnapshot();
    if (state.phase !== "ready") return;
    const now = Date.now();
    for (const machine of state.machines) {
      if (machine.reach !== "online" || this.asking.has(machine.id)) continue;
      const daemon = store.daemonFor(machine.id);
      if (daemon === undefined) continue;
      const instance = machine.health?.instanceId ?? null;
      const asked = this.askedAt.get(machine.id);
      if (asked !== undefined && !boardDue(this.held.get(machine.id), asked, now, this.watchers > 0, instance)) continue;
      this.askedAt.set(machine.id, now);
      this.asking.add(machine.id);
      void daemon
        .listTasks()
        .then(
          (list) => {
            const config = readStamp(list);
            this.held.set(machine.id, {
              tasks: readTasks(list.tasks),
              at: Date.now(),
              read: "known",
              daemon: instance,
              config,
              tombstones: readTombstones(list.tombstones),
            });
            this.answered.add(machine.id);
            if (config === null) this.copies.delete(machine.id);
            else this.readCopy(machine.id, config);
          },
          (cause: unknown) => {
            const board = this.held.get(machine.id);
            if (meansRouteAbsent(cause)) {
              this.held.set(machine.id, { tasks: [], at: Date.now(), read: "absent", daemon: instance, config: null, tombstones: [] });
              this.answered.add(machine.id);
            } else if (board !== undefined && board.read !== "absent") {
              // What it last said stands; a refusal or a lost answer is not news about its tasks.
              this.held.set(machine.id, { ...board, read: "failed" });
            }
          },
        )
        .finally(() => {
          this.asking.delete(machine.id);
          this.publish();
        });
    }
  }

  /** A configured machine's board, read again only when the revision or hash it names is not the copy held. */
  private readCopy(machine: MachineId, stamp: BoardStamp): void {
    const copy = this.copies.get(machine);
    if ((copy !== undefined && copy.revision === stamp.revision && copy.hash === stamp.hash) || this.fetchingCopy.has(machine)) return;
    const daemon = store.daemonFor(machine);
    if (daemon === undefined) return;
    this.fetchingCopy.add(machine);
    void daemon
      .board()
      .then(
        (answer) => {
          const read = readBoardDocument(answer);
          // A board this build cannot read is no copy: the others, or the default, stand (compatibility.md rule 2).
          if (read === null) this.copies.delete(machine);
          else this.copies.set(machine, read);
        },
        () => {
          // A failed read leaves the copy held; the next list that names another revision asks again.
        },
      )
      .finally(() => {
        this.fetchingCopy.delete(machine);
        this.publish();
      });
  }

  private publish(remember = true): void {
    const machines = machinesOf(store.getSnapshot());
    const present = new Set(machines.map((machine) => machine.id));
    const copies = new Map([...this.copies].filter(([id]) => present.has(id)));
    const read = accountBoard(copies.values());
    // Before any copy is read, what this device last drew stands in for the default.
    const board = read.revision === null ? this.remembered : read;
    const tasks = boardTasks(machines, this.held, board.board);
    const supported = [...this.held].filter(([, held]) => held.read !== "absent").map(([id]) => id);
    const configured = new Map(
      [...this.held].flatMap(([id, held]): [MachineId, BoardStamp][] => (held.config === null || !present.has(id) ? [] : [[id, held.config]])),
    );
    // A poll that changed nothing redraws nothing: every session row's menu reads this store.
    const asked = new Map([...this.asked].map(([key, { press: _, ...held }]): [string, Asked] => [key, held]));
    const pressed = [...this.asked].map(([key, held]) => `${key}:${held.press}`).join(",");
    const copiesKey = [...copies].map(([id, copy]) => `${id}:${copy.revision}:${copy.hash}`).join(",");
    const configuredKey = [...configured].map(([id, stamp]) => `${id}:${stamp.revision}:${stamp.hash}`).join(",");
    const stones = [...this.held].map(([id, held]) => `${id}:${held.tombstones.map((one) => `${one.id}@${one.epoch}>${one.movedTo}`).join(";")}`).join(",");
    const key = [
      boardSignature(tasks),
      [...this.answered].join(","),
      supported.join(","),
      pressed,
      copiesKey,
      configuredKey,
      `${board.revision ?? ""}:${board.hash ?? ""}`,
      stones,
    ].join("\u0002");
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.snapshot = {
      tasks,
      read: new Set(this.answered),
      supported: new Set(supported),
      configured,
      copies,
      board,
      asked,
      held: new Map(this.held),
    };
    if (remember) {
      try {
        window.localStorage.setItem(TASKS_STORAGE_KEY, rememberBoards(this.held));
        const written = rememberAccountBoard(board);
        if (written !== null && (board.hash !== this.remembered.hash || board.revision !== this.remembered.revision)) {
          window.localStorage.setItem(BOARD_STORAGE_KEY, written);
          this.remembered = board;
        }
      } catch {
        // Over quota or private mode: the board in memory is whole, and only a relaunch forgets it.
      }
    }
    for (const listener of [...this.listeners]) listener();
  }
}

/** In the order and under the names the machines are drawn with, so the board and the strip agree. */
function machinesOf(state: AppState): BoardMachine[] {
  return machinesAsDrawn(state).map(({ machine, name }) => ({ id: machine.id, name, reach: machine.reach }));
}

export const board = new BoardStore();
