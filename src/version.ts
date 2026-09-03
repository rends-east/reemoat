/**
 * What build of the daemon this is.
 *
 * A literal rather than a read of `package.json`, for the reason the control
 * plane's own `VERSION` gives one package over: a runtime file read is a new
 * failure path, and on the daemon it would be a new failure path at startup on a
 * machine nobody is sitting in front of. `pincheck` asserts this string against
 * `package.json` instead, so the two cannot drift silently.
 *
 * **It is announced and never enforced.** It rides the tunnel handshake as
 * `DAEMON_VERSION_HEADER`, the relay records it against the machine, and nothing
 * anywhere branches on it — not authorization, not routing, not feature
 * selection. That restraint is the point rather than an omission: the moment a
 * relay behaves differently for `0.1.0` than for `0.2.0`, every daemon in the
 * fleet has to be updated in lockstep with it, which is the thing the version
 * range in `relay/protocol.ts` exists to avoid. Capability lives in the protocol
 * version, which is negotiated; this is a label, which is reported.
 *
 * What it is for, then, is the question a weekly release cannot be planned
 * without: *what is actually out there?* `cpctl admin fleet` answers it.
 *
 * ⚠ **Reporting a version is not a step toward acting on one.** A daemon does not
 * update itself and is never told to — `deploy/deploy.sh`, run by whoever owns the
 * host, is the whole mechanism, and fleet rollout is a stated non-goal (Q7.42).
 * This constant travels one way, outward, so that a person can look; nothing
 * anywhere sends a version *to* a daemon, and adding that is a different decision
 * from this one.
 *
 * ⚠ **The coding-agent CLIs beneath it are a different subject, and all four now
 * move on a timer.** `src/agentupdate.ts` runs `deploy/agents.sh` daily. Every
 * reason the paragraph above exists is about *this* process: a daemon restart
 * interrupts every turn in flight and drops every pending approval. Replacing a
 * program the daemon spawns fresh at each session start costs none of that, needs no
 * restart, and changes nothing in this repository — so it neither contradicts this
 * nor is a step toward it.
 */
export const DAEMON_VERSION = "0.5.0";
