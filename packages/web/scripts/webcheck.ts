#!/usr/bin/env node
import { finish } from "./webcheck.env.js";
import { closeWss } from "./webcheck.ws.js";

/**
 * The web client's regression driver; this list is the running order: closeWss lands between two sections, and one rewrites window.location before router.ts first evaluates.
 * Sections are siblings, not a directory, because their ../src paths resolve relative to this folder. Run with pnpm webcheck.
 */

await import("./webcheck.stream-and-http.js");
await import("./webcheck.permission-card.js");
await import("./webcheck.composer-and-config-bar.js");
await import("./webcheck.decision-surfaces.js");
await import("./webcheck.command-menu-and-browser.js");
await import("./webcheck.chips-and-tail.js");
await import("./webcheck.tail-subagents-and-runs.js");
await import("./webcheck.transcript-refusals-and-composer.js");
await import("./webcheck.interrupted-and-spawn-routes.js");
await import("./webcheck.history-and-cursor.js");
await import("./webcheck.elicitation-and-links.js");
await import("./webcheck.accounts-and-credentials.js");
await import("./webcheck.devices.js");
await import("./webcheck.native-bridge.js");
await import("./webcheck.agent-card.js");
await import("./webcheck.agent-install.js");
await import("./webcheck.settings-routing.js");
await import("./webcheck.shell-and-enrollment.js");
await import("./webcheck.gate-and-server-settings.js");
await import("./webcheck.accounts-on-this-computer.js");
await import("./webcheck.legal-and-consent.js");
await import("./webcheck.machine-limit-and-probe.js");
await import("./webcheck.navigation.js");
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
await import("./webcheck.local-route.js");
await import("./webcheck.e2ee.js");
await import("./webcheck.typography.js");

finish();
