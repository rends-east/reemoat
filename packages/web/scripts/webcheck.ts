#!/usr/bin/env node
import { finish } from "./webcheck.env.js";
import { closeWss } from "./webcheck.ws.js";

/**
 * The regression driver for the browser client.
 *
 * This file is the running order and nothing else: twenty-eight subject modules
 * beside it hold the assertions, and five `webcheck.env`/`modules`/`ws`/`source`/
 * `rows` modules hold what they share. It was one 29 751-line file until it was
 * past the point of being openable, and the cut is a pure move — the emitted
 * output is byte-for-byte what it was.
 *
 * They are **siblings rather than a `webcheck/` directory**, which looks untidy
 * and is the only arrangement that works: 135 of the assertions reach a source
 * file through `readFileSync(new URL("../src/…", import.meta.url))`, a runtime
 * path no tsconfig alias touches, and there are `../../../src/`,
 * `../../control-plane/` and one `../../../../services/` besides. One directory
 * down, every one of them resolves somewhere that does not exist — measured,
 * `Cannot find module '…/packages/web/scripts/src/stream.js'` on the first run.
 * Moving them costs rewriting several hundred paths inside bodies that are
 * otherwise untouched.
 *
 * The sections are `await import`ed one at a time rather than imported statically,
 * because **this list is the order** and `closeWss()` has to land between two of
 * them. Static imports would evaluate the lot before the first line of this body
 * ran, and the order is load-bearing beyond which lines print: one section
 * rewrites `window.location.pathname` and leaves it rewritten, and `router.ts` is
 * first evaluated underneath it.
 *
 * Fourth of its kind: `harness.ts` covers the session paths, `authcheck.ts` the
 * auth paths, `relaycheck.ts` the relay, and this one `packages/web`. Before it
 * existed the web client's entire safety net was `tsc --noEmit`, which is to say
 * that the four rules it is actually built on — the cursor, the rotation, the
 * route memo and the replay — were protected by nothing at all. Every one of them
 * fails *silently*: a duplicated or dropped event in a transcript looks like
 * something the agent said.
 *
 * Two things make this drivable at all:
 *
 *   - `window` is stubbed before the imports, so the modules that read it at load
 *     time (`machine.ts` computes `ROUTE_MODE` from the URL) can be imported under
 *     `tsx` with no DOM. That is why they are dynamic, and why `webcheck.env.ts`
 *     is imported for its side effect by `webcheck.modules.ts` — the import graph
 *     now pins the order that statement order used to give for free.
 *   - `SessionStream` takes its machine as a collaborator, so a duck-typed stand-in
 *     replaces the token minting and route probing without a control plane. The
 *     socket, by contrast, is a **real** WebSocket against a real loopback server:
 *     the rotation overlap is a race between two live sockets and stubbing it away
 *     would remove the only thing worth testing.
 *
 * Run it after touching anything in `packages/web/src`:
 *   pnpm webcheck
 */

await import("./webcheck.stream-and-http.js");
await import("./webcheck.permission-card.js");
await import("./webcheck.composer-and-config-bar.js");
await import("./webcheck.decision-surfaces.js");
await import("./webcheck.command-menu-and-browser.js");
await import("./webcheck.context-chips-and-tail.js");
await import("./webcheck.tail-subagents-and-runs.js");
await import("./webcheck.transcript-refusals-and-composer.js");
await import("./webcheck.interrupted-and-spawn-routes.js");
await import("./webcheck.history-and-cursor.js");
await import("./webcheck.elicitation-and-links.js");
await import("./webcheck.accounts-and-credentials.js");
await import("./webcheck.agent-card.js");
await import("./webcheck.settings-routing.js");
await import("./webcheck.shell-and-enrollment.js");
await import("./webcheck.gate-and-server-settings.js");
await import("./webcheck.machine-limit-and-probe.js");
await import("./webcheck.navigation-and-telegram.js");
closeWss();
await import("./webcheck.plugin-protocol.js");
await import("./webcheck.plugin-consent.js");
await import("./webcheck.plugin-install-and-market.js");
await import("./webcheck.plugin-reach-and-mirror.js");
await import("./webcheck.panes-and-builder-exit.js");
await import("./webcheck.strip-chosen-tile.js");
await import("./webcheck.strip-order-and-hidden.js");
await import("./webcheck.refusing-controls.js");
await import("./webcheck.harness-and-systems.js");
await import("./webcheck.model-list.js");

finish();
