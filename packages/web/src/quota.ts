import type { Me } from "./wire.js";

/**
 * How many machines this person may have, and what to say when they may not.
 *
 * **Its own file, and not `instance.ts`.** That one holds statements about the
 * *instance* — what registration is set to, whether mail works — and this is a
 * statement about a *person*. Not `account.ts` either, which is the vocabulary
 * of refused credentials. Everything the machine limit needs a screen to know is
 * here: the predicate, the four sentences, the badge, the admin's consequence
 * line, and the settings-field validator, so the rule has one home rather than
 * being split by which screen happens to ask.
 *
 * **Every entry point takes `Me | null` and never bare numbers.** That is a
 * structural guard rather than a style: `me.machineCount` and
 * `state.machines.length` are different numbers — the list includes machines
 * somebody granted you and the limit counts only the ones you own — and a
 * signature taking a count would make passing the wrong one natural.
 *
 * **It fails open on `unknown`**, with `mailUsable` and `showsGateLink` and
 * against `adminMayInvite`. The rule is *fail closed where the cost is a missing
 * screen, fail open where the cost is a locked-out person*, and this is the
 * second kind: `AddMachine` in `MachinesSection` is the **only** way to create a
 * machine anywhere in this app, `bootstrap`'s catch really does reach
 * `phase: "ready"` with `me === null`, and a control plane rolled back past this
 * release reaches it permanently. Failing closed there leaves somebody with
 * quota, no machines, and no route to one — which is no sessions, which is no
 * product. Failing open costs one refused submit carrying the server's own
 * sentence, which is how every other form here already behaves.
 */

/**
 * The fleet-wide ceiling, mirrored from `MAX_MACHINES_PER_USER`.
 *
 * Hand-copied like everything in `wire.ts`, and pinned by `webcheck` reading the
 * literal straight out of `packages/control-plane/src/machines.ts` — a number
 * this screen prints in a refusal has to be the number the server enforces.
 */
export const HARD_MACHINE_CEILING = 50;

/** The settings key, named once so the four call sites cannot disagree. */
export const MACHINE_LIMIT_KEY = "machines.per_user";

export type MachineQuota =
  /** No quota reported at all: an unreadable `me`, or a control plane without it. */
  | { kind: "unknown" }
  | { kind: "room"; count: number; limit: number }
  /** At or past a limit of one or more. */
  | { kind: "full"; count: number; limit: number }
  /** The limit is zero — nobody gets a machine here without an admin. */
  | { kind: "none"; count: number };

export function machineQuota(me: Me | null): MachineQuota {
  const limit = me?.machineLimit;
  // `null` and `undefined` collapse together on purpose: one is a control plane
  // that has no opinion, the other is one that predates the field, and no screen
  // does anything different about them.
  if (typeof limit !== "number") return { kind: "unknown" };
  const count = typeof me?.machineCount === "number" ? me.machineCount : 0;
  if (limit === 0) return { kind: "none", count };
  return count >= limit ? { kind: "full", count, limit } : { kind: "room", count, limit };
}

/**
 * May this person be offered a way to add a machine?
 *
 * The server's own answer where there is one — `canAddMachine` — because that
 * rule belongs to the control plane. Written as *only a definite no hides a
 * door*, which is `showsGateLink`'s exact form: three states for the copy, two
 * for the rule, and keeping that split in two functions is the whole of the
 * `gateOffer`/`showsGateLink` lesson.
 */
export function mayAddMachine(me: Me | null): boolean {
  if (typeof me?.canAddMachine === "boolean") return me.canAddMachine;
  const kind = machineQuota(me).kind;
  return kind !== "full" && kind !== "none";
}

/**
 * Why they cannot, in one sentence — or `null` when they can.
 *
 * **The invariant, asserted by `webcheck`: this is `null` if and only if
 * `mayAddMachine` is true.** There is never a door missing without a sentence
 * saying why, which is `gateNotice`'s property verbatim. It is also why there is
 * deliberately no "2 of 5" line while there is room: that would break the iff,
 * and a progress readout is a second function's job.
 *
 * "Whoever runs this control plane" rather than "the admin", because the person
 * reading this is not the person with a shell on it — `gateNotice`'s vocabulary,
 * for its reason.
 */
export function machineQuotaNotice(me: Me | null): string | null {
  /*
   * **`mayAddMachine` first, which is what makes the iff true by construction
   * rather than by the server keeping two fields consistent.**
   *
   * These two functions read different inputs: `mayAddMachine` prefers the
   * server's `canAddMachine`, and everything below derives from `machineCount`
   * and `machineLimit`. Written without this line the pair disagreed the moment
   * those disagreed, in *both* directions — `{count: 0, limit: 5, can: false}`
   * hid the door and returned `null`, and `{count: 5, limit: 5, can: true}` drew
   * the door beside a sentence saying it was full.
   *
   * It was not reachable against the control plane of the day, because
   * `canAddMachine` was `owned < limit` there and could not contradict its own
   * numbers. That is exactly the reassurance worth distrusting: the field exists
   * *so that* the rule can gain a clause the numbers do not show, which is what
   * `GET /v1/me`'s own docblock says, and `machineLimit` is `number | null` on
   * the wire so `{canAddMachine: false, machineLimit: null}` is a legal shape
   * today. The first added clause would have made every screen silent.
   *
   * The `gateOffer`/`showsGateLink` lesson, one file over and one release later:
   * a rule split across two functions that answer from different fields is a
   * rule that holds until somebody changes one of them.
   */
  if (mayAddMachine(me)) return null;
  const quota = machineQuota(me);
  switch (quota.kind) {
    case "unknown":
    case "room":
      /*
       * The door is shut and the numbers do not explain it, so this is the
       * server having said no for a reason it did not send. Deliberately vague
       * about the reason and specific about the remedy — inventing a cause here
       * would be this screen guessing, which is the other half of the same
       * lesson.
       */
      return "You cannot add a machine on this account. Ask whoever runs this control plane why.";
    case "none":
      return quota.count === 0
        ? "Your machine limit is 0, so you cannot add one. Ask whoever runs this control plane to raise it."
        : "Your machine limit is 0, so your machines have stopped working. " +
            "Only whoever runs this control plane can raise it again.";
    case "full": {
      const over = quota.count - quota.limit;
      if (over <= 0) {
        return (
          `You are using all ${quota.limit} of your ${quota.limit} machines. ` +
          "Retire one, or ask whoever runs this control plane to raise the limit."
        );
      }
      return (
        `You have ${quota.count} machines and a limit of ${quota.limit}, so the newest ` +
        `${over === 1 ? "one has" : `${over} have`} stopped working. ` +
        "Retire one, or ask whoever runs this control plane to raise the limit."
      );
    }
  }
}

/**
 * The one badge a machine row draws, by precedence.
 *
 * Over-limit subsumes not-enrolled because it is the fact that has to be fixed
 * first, and because two boxes beside a truncating name on a 390px phone is the
 * collapse the kebab exists to prevent. `userState`'s shape, for its reason.
 */
export function machineBadgeText(machine: {
  overLimit: boolean;
  ownerDisabled?: boolean;
  enrolled: boolean;
}): string | null {
  // The owner's ban outranks the limit: an over-limit machine whose owner is
  // also banned cannot be fixed by retiring anything, so naming the limit first
  // would send the reader to the wrong remedy.
  if (machine.ownerDisabled === true) return "owner disabled";
  if (machine.overLimit) return "over the limit";
  if (!machine.enrolled) return "not enrolled";
  return null;
}

/**
 * What lowering somebody's limit costs, or `null` when it costs nothing.
 *
 * **The admin screen draws its confirmation iff this is non-null**, so whether
 * to ask is a pure function rather than a `<` buried in JSX — which is what
 * makes it assertable at all.
 *
 * It names the count and the rule ("the newest") and never machine names:
 * `GET /v1/admin/users` carries no names, and a round trip to fetch them would
 * be a second source of truth about an ordering the server ranks authoritatively.
 */
export function machineLimitChangeNotice(name: string, owned: number, next: number): string | null {
  const stopping = owned - next;
  if (stopping <= 0) return null;
  return (
    `${name} owns ${owned} machine${owned === 1 ? "" : "s"}. A limit of ${next} stops the newest ` +
    `${stopping === 1 ? "one" : String(stopping)} working — raising it again brings ` +
    `${stopping === 1 ? "it" : "them"} back.`
  );
}

/**
 * How much of the allowance is spent, as a readout — or `null` when there is
 * nothing worth saying.
 *
 * **This is the second function `machineQuotaNotice` names**, and it exists so
 * that one can keep its invariant. That one is `null` **iff** the door is drawn,
 * which is what `webcheck` asserts; a "2 of 5" line folded into it would be
 * non-`null` while there is room and break the iff on its first call. A readout
 * is a different sentence with a different rule: it is drawn *because* there is
 * a limit, not because there is a problem.
 *
 * `null` for `unknown` rather than a guess. A count with no limit beside it is a
 * number nobody can act on, and a control plane that predates the field really
 * does send one — which is the same reason `mayAddMachine` fails open there.
 *
 * The count is the one on `Me`, so it is machines this person **owns**; the list
 * on screen is longer, because it includes machines granted to them. Those are
 * different numbers and this is the one the limit is enforced against.
 */
export function machineAllowanceText(me: Me | null): string | null {
  const quota = machineQuota(me);
  switch (quota.kind) {
    case "unknown":
      return null;
    // Stated rather than hidden: `count of 0` is exactly what an instance that
    // hands out no machines looks like, and the sentence explaining it is the
    // notice one function up, which is non-`null` in precisely this state.
    case "none":
      return `${quota.count} of 0`;
    case "room":
    case "full":
      return `${quota.count} of ${quota.limit}`;
  }
}

/**
 * What lowering the **fleet-wide** default costs, or `null` when it costs
 * nothing.
 *
 * `machineLimitChangeNotice`'s sibling, and the same rule: **the admin screen
 * confirms iff this is non-null**, so the decision is a pure function rather
 * than a `<` in JSX. It arrived later than it should have — the per-user panel
 * confirmed from the start while this one, which moves *every* account on the
 * instance at once, wrote on a single tap with nothing said.
 *
 * **It names no count, and cannot.** Whose machines stop depends on what each
 * person owns and on their own override, and this screen holds neither; the
 * numbers live on `GET /v1/admin/users`, one screen away. A round trip to total
 * them would be a second source of truth about a ranking the server decides, so
 * the sentence states the rule instead — which is also the honest thing, because
 * the answer changes between reading it and saving.
 *
 * Empty means unset, and unset resolves to the fleet ceiling on the server
 * (`instanceMachineLimit`), so clearing this field is always a raise or a
 * no-op and never asks. Both sides are read the same way for that reason.
 */
export function fleetMachineLimitNotice(current: string, next: string): string | null {
  const resolve = (raw: string): number => {
    const text = raw.trim();
    if (text.length === 0) return HARD_MACHINE_CEILING;
    return /^\d+$/.test(text) ? Number.parseInt(text, 10) : HARD_MACHINE_CEILING;
  };
  const from = resolve(current);
  const to = resolve(next);
  if (to >= from) return null;
  return to === 0
    ? "Nobody on this instance will be able to run a machine, and everybody's machines stop working. " +
        "Nothing is deleted — raising the limit brings them all back."
    : `Everyone whose limit comes from the instance default drops from ${from} to ${to}. ` +
        "Anybody owning more than that has their newest machines stop working — nothing is deleted, " +
        "and raising the limit brings them back.";
}

/**
 * What is wrong with a typed limit, as a sentence — a typo catcher rather than a
 * validator, which is `smtpProblem`'s posture one file over.
 *
 * Empty is `null` because "no limit set here" is a legal state and a form that
 * refused it could never hand the value back to the environment. One regex
 * rejects `-1`, `2.5` and `abc` together. The ceiling clause is what stops the
 * screen accepting a number the server would refuse.
 */
export function machineLimitProblem(draft: string): string | null {
  const text = draft.trim();
  if (text.length === 0) return null;
  if (!/^\d+$/.test(text)) return "The limit must be a whole number, or empty to use the default.";
  if (Number.parseInt(text, 10) > HARD_MACHINE_CEILING) {
    return `${HARD_MACHINE_CEILING} machines per person is the fleet-wide ceiling.`;
  }
  return null;
}
