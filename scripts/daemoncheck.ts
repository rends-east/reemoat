#!/usr/bin/env node
import { finish } from "./daemoncheck.env.js";

// Runs the daemoncheck modules in order, one await at a time: they share one app, registry and sandbox, and later sections depend on earlier ones.
// Siblings, not a subdirectory: several assertions read `../src/…` relative to `import.meta.url`.

await import("./daemoncheck.containment-and-session-routes.js");
await import("./daemoncheck.agent-login-and-launch.js");
await import("./daemoncheck.store-and-worktrees.js");
await import("./daemoncheck.browsing-and-signing-out.js");
await import("./daemoncheck.import-and-mounts.js");
await import("./daemoncheck.stream-and-events.js");
await import("./daemoncheck.git-pty-and-fs.js");
await import("./daemoncheck.agent-output-and-uploads.js");
await import("./daemoncheck.restart-and-resume.js");
await import("./daemoncheck.permissions-and-turns.js");
await import("./daemoncheck.after-the-turn-and-config.js");
await import("./daemoncheck.mid-turn-messages.js");
await import("./daemoncheck.plugin-manifest-and-store.js");
await import("./daemoncheck.plugin-surfaces.js");
await import("./daemoncheck.plugin-install-and-rollback.js");
await import("./daemoncheck.plugin-scopes-and-hooks.js");
await import("./daemoncheck.plugin-routes.js");
await import("./daemoncheck.systems-and-harnesses.js");
await import("./daemoncheck.contributions-and-launch.js");
await import("./daemoncheck.agent-routes-and-capabilities.js");
await import("./daemoncheck.agent-install.js");
await import("./daemoncheck.e2ee.js");
await import("./daemoncheck.announce.js");

finish();
