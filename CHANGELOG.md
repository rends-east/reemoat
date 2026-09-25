# Changelog

All notable changes to Reemoat are recorded here.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Under 0.x the minor is the breaking one.** Before 1.0.0 a minor bump may change
the daemon's HTTP surface, the relay's tunnel protocol version, or the control
plane's schema. Pin a tag. There are deliberately no rolling `0.1` or `0` image
tags, because on a 0.x project those names would mean "may break without warning"
while reading like stability.

**The shape of this file is a contract, not a convention.** `pnpm pincheck`
asserts that the newest released heading is the version in `package.json`, and
`deploy/ci-release.sh` extracts a release's notes by reading from its heading to
the next one. So a released heading is exactly `## [x.y.z] - YYYY-MM-DD`,
`## [Unreleased]` carries no date, and a section ends where the next `##` begins.

One rule that is easy to miss: **no `Q<n>.<m>` citations here.** Everywhere else
in this repository a decision can be cited by number and `pnpm docscheck` proves
it resolves. This file is deliberately outside that corpus — adding it would let a
stale symbol in `docs/DECISIONS.md` "resolve" against prose that merely mentions
it — so a citation here would be the one kind nothing checks.

## [Unreleased]

### Added

- **Agents can message each other, on one machine and across your machines.** Every session can list the others and write to one (`send_message`), whichever harness either runs and whichever of your machines it is on. Every message is acted on: it wakes a session that is idle and reaches one that is working inside its turn, and the answer comes back the same way, so nothing polls. A sender can also ask to be told once if the other session stops without answering. claude sessions no longer carry Claude Code's own session list, which never showed any of these. A message for a machine that is off is kept trying for a day. Messages between machines are encrypted end to end, as the app's are: the relay carries them without being able to read them. A message from another agent is drawn as one, never as your own, and a session stops taking work from agents after twenty turns in a row without a word from you. The app links your machines by itself; each machine's settings list its links under **Agent links**. Machines of other people, or on another server, cannot be reached yet. `REEMOAT_PEER_MESSAGES=off` removes the tools.
- **A dark theme.** The menu has a **Dark theme** switch under everything else; the app stays light until you turn it on. The choice belongs to this device rather than an account: every account on it shares it, and signing out keeps it. Every colour was re-chosen for a dark background rather than inverted, and text, borders, the diff and the question card keep the contrast they have in the light theme. The page is dark from its first frame, and in the desktop app the window's title bar follows the switch too.

### Security

- **Continuous deployment no longer trusts the deploy host's key on first use.** `deploy/ci-deploy.sh` pins the new `DEPLOY_KNOWN_HOSTS` secret with `StrictHostKeyChecking=yes` and refuses to deploy without it. Add the secret before the next dispatch: the host's keys as `ssh-keyscan -H <DEPLOY_HOST>` prints them, checked against the host's own fingerprints.

### Fixed

- `install.sh` printed the id of the default control-plane image rather than the one `REEMOAT_CP_IMAGE` in `control-plane.env` named.
- A control plane whose `mail.public_url` is its own origin no longer warns that it serves no browser UI: it serves `/confirm`, `/reset` and `/verify` from the gate bundle. The warning remains for a control plane running without that bundle.
- A mail failure from TLS or the socket is stored truncated and stripped of CR/LF, as SMTP replies already were, so it can no longer stretch or split the Email settings banner.
- The login throttle key no longer cuts the tail of a long address when the name is a maximal email address: its ceiling is derived from the longest key any builder writes.
- **"Use another account" appears on the forced password change again.** It was never drawn there, so someone with several accounts could only sign out.
- A message sent while an earlier send on the same session was still in flight could have its echo cleared early by the earlier one's late answer or refusal.
- The server log view keeps following new lines while you are at the bottom, however many lines one refresh adds. It now opens on the newest line.
- A tool call whose only argument is its content (`content`, `text`, `new_string`) is shown with that content rather than as a call with no input.
- A one-shot agent ask (a capability or model read) keeps its concurrency slot until the agent process has actually exited, and daemon shutdown waits for it; the slot used to free during the agent's teardown.
- The idle sweep's wedged-turn reap runs even when parking an idle session throws in the same tick.
- Raising `REEMOAT_SESSION_CREATE_BURST` takes effect at once instead of leaving the old ceiling in place until the bucket refilled; lowering it still clamps.
- An unreachable machine no longer flickers into view every 15 seconds while it is re-checked: a re-check keeps the last answer until the new one arrives.
- **grok's questions, plan approvals and MCP forms reach the question card** instead of failing with "Method not found": its own `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode` and `_x.ai/mcp/elicit` requests are answered in the shapes grok accepts, and grok is started with its 30-minute question timeout switched off, so a question waits for you.
- **A question or plan the agent raises between turns is no longer cancelled on arrival.** When claude kept working after its turn ended (after a background workflow finished), every question and plan approval it raised was answered "no turn to answer into" instantly, and one still waiting when a turn ended was cancelled too. A request now waits until you answer it, dismiss it, press Stop, or the agent goes away. A plan raised between turns offers only the grant that works there: claude cannot restart into a cleared context outside a turn.
- **The working line shows whenever the agent is working**, including work claude starts by itself after background tasks finish, and counts the tokens streamed since the last tool call (`working… · 3m · ↓ 1.2k tokens`). Stop works there too.
- **Finished background tasks survive an effort change.** Switching effort away from ultracode restarts the agent, and the list of finished tasks went with it. It is now kept across an agent restart, a park and a clean daemon restart; a task still running when its agent is replaced is shown as stopped.
- **A message is sent and shown exactly as typed.** The macOS app no longer turns quotes into «» or “”, `--` into a dash, or text-replacement shortcuts into their expansions, and the message box and the question card's own-answer box switch off spelling substitution. Your own messages are drawn as plain text, so a numbered list stays text you can select, and the first line's indentation is no longer trimmed.
- **Sending a message always brings the conversation to the bottom**, even while the agent is streaming; the conversation no longer drops off the bottom by itself, and a line wrapping in the message box no longer shifts it.
- **The box for your own answer on a question card no longer draws a dark rectangle** sticking out past its row.
- **Bottom sheets close with a swipe on Android**, including a quick flick and a fully expanded picker, and leave from where your finger let go instead of jumping back first. Every sliding panel shares one gesture and one animation.
- **A sliding panel no longer flickers or stutters while it moves**: the drag is one composited transform per frame, so the grab bar stays crisp. New session can be dragged from anywhere on it, as the pickers can.
- **Your own answer on a question card can hold line breaks**: Shift+Enter on a keyboard (Enter moves the card on), Enter on a phone.
- **Sending while the agent is answering no longer makes the conversation jump or blink**: the message is never drawn twice, and the working line keeps its place when a queued message is handed over or a turn ends.
- **Send and Stop cross-fade instead of swapping instantly**, and a tap during the swap always lands on the button that is appearing.
- **The Android launcher icon has the same margin as the macOS one** instead of filling the whole circle.
- **Swiping between machines on a phone turns the page like Telegram's folders**: the neighbouring machine's list slides in beside the current one and the release carries both on, instead of springing back and then jumping to the new machine.
- **The machine names in the phone's top strip are one pixel smaller** (15px).
- **Flicking quickly through several machines on a phone keeps moving**: a flick made while the previous page is still settling carries the pages on to the next machine instead of being lost.
- **The selected machine is marked by a pill that travels with the page**, stretching from one tab to the next as you swipe, tap or return to All, instead of an underline that jumped.
- **On a phone, swiping right on the All page pulls out the side menu**, following your finger, as Telegram does on its first folder; the left edge stays the system's Back.
- **Pulling the session list down refreshes it**: every machine is re-dialled and re-listed while a gap with the working mark holds open, and it closes when the answers are in.
- **Connection trouble is a small spinner at the bottom-left** that expands into its words on hover or tap, instead of banners above the list and the conversation. A reconnect under a second shows nothing, and a machine that is simply switched off does not hold it on the All tab.
- **A drag that starts on the dimmed area beside an open panel moves the panel**: the side menu slides back with your finger, and a bottom sheet slides down, the same as dragging the panel itself. Tapping a picker's dimmed area no longer also taps what is under it.
- **On a phone, dragging a conversation to the right takes you back to the list**: the conversation follows your finger with the list revealed underneath, and lands on the same list the back button gives. A code block that can still scroll keeps the drag, and a field, a selection or an open menu never starts one.
- **Resizing the window while the agent streams keeps the conversation at the bottom** instead of dropping off it, and the scroller is re-synced after a resize so what is painted and what the mouse hovers stay in the same place.
- **The desktop machine column is wider (80px, Telegram's width) with larger buttons**, and its menu button is tall enough that the menu bar macOS slides over a full-screen window no longer covers it.
- **Renaming a session no longer shifts the header**: the box is drawn where the name stands, hugs the text, and has no heavy focus ring. The session name shows the text caret on hover.
- **Text on a phone or tablet is two pixels larger throughout** (conversation and session titles 16px instead of 14px); a desktop keeps its size.
- **The menu button at the top left of the phone list is larger** (a 44px button with a 20px glyph), as is the back button at the top of a conversation.
- The app no longer gives up on a slow request before the machine's own budget for it runs out. Each slow route waits for its daemon's budget plus 30 seconds (a new session up to 215s, a prompt 150s, an agent capability read 290s) instead of a flat 90s, which drew a healthy machine as unreachable.

## [0.11.0] - 2026-09-23

### Added

- **Several accounts in one app.** The menu now opens on your face, your name and
  the server the account is on; pressing the name lists every account on this
  computer, the current one ringed, then **Add account**. Tapping another account
  switches to it — on a Mac at once and exactly as you left it, with the work in the
  account you left still running; on Windows, Linux and Android the app reloads
  onto it. **Add account** signs in to another account, on the same server or
  another one, while the others stay signed in — up to ten.
- **Every account gets this computer as a machine of its own**: its own daemon,
  database, sessions and working copies, running from when the app opens until it
  quits whichever account is on screen, and using one of that account's machine
  slots. The first account on a server keeps that server's folder; each further one
  lives in `~/.reemoat/servers/<server>@<user id>/`.
- **The server step opens on the server the app was built for**, greyed, with a
  pencil beside it to change it. An app built without one opens on an empty box, as
  before.

### Removed

- **The "Rent a machine" link.** An instance whose control plane set
  `REEMOAT_CP_MACHINES_OFFER_URL` drew it under the one-line installer — on the
  home screen of an empty fleet and in Settings → Machines. It is gone from the app
  and from `GET /v1/instance`, and the variable no longer does anything: a control
  plane that still finds it in its environment says so once at startup, and the
  line can be deleted. Adding a machine is unchanged — the one-line installer is
  still on all three screens, and so is the sentence shown in its place when the
  machine limit is reached. An app from an earlier release stops drawing the link
  as soon as its control plane is updated.

### Changed

- **New session no longer installs or signs in to an agent.** When nothing on a
  machine can start, the screen says why in one sentence and offers one button,
  **Agent settings**, which opens that machine's Agents list. Coming back returns
  to New session with the folder and the chosen agent as they were.
- **The Agents list can finish the job.** A row that is not installed, not signed
  in or would not start now has **Set up <agent>** in its menu. It opens that
  agent's own screen: install with the installer's output, then sign in. The
  list's own Install, which ran with no output, is gone.
- **Settings → Account → Server address shows your account's server and no longer
  changes it.** Another server is another account: add it from the menu. A wrong
  address typed while signing in is still corrected from **‹ Server** on the
  sign-in screen.
- **Signing out signs out of the account on screen and takes it off this
  computer**, stopping its daemon; the app moves to the account you used before it,
  or to the sign-in for that server if it was the last. Signing in as that person
  again later brings back the same device and the same machine. An account whose
  session ends by itself stays in the menu, marked *signed out*, and its sign-in
  screen offers a way back to your other accounts and a way to remove it.
- **Updating keeps you signed in.** The first launch asks the server whose sign-in
  this computer holds and moves it to that account; the device and the machine
  beside it move only where the server confirms they are that account's. Going
  back to an earlier release afterwards asks you to sign in again. ⚠ **Where the
  one-line installer set this computer up, update with its daemon running.** If it
  has not answered by the time the app asks, the app sets the computer up again as
  a second machine, and the first — with its sessions — stays offline.

### Fixed

- **The computer the app runs on is called "local" and comes first in the machine
  list.** The machine strip, the desktop rail and New session named it by its
  host name ("MacBook-Pro…") and sorted it among the others by name. On this
  computer they now say "local" and list it first — from the moment the app
  opens, before its daemon has started, and without changing back while the
  daemon restarts — and New session picks it by default whenever it is reachable.
  Everywhere else — your phone,
  another computer, anybody you share it with — it keeps its real name, and
  Settings → Machines still shows the real name with "this device" beside it, so it
  can be renamed there as before. Another machine that is itself named "local",
  such as one an earlier version of the app set up, is shown with its id added
  ("local-2405b5ea…") so only this computer reads "local". If you have dragged it
  somewhere in the list, it stays where you put it; if you had rearranged the
  machines before this release, it stays where it was until you move it.
- **The app can set a computer up for more than one server, and for more than one
  account on each.** Signed in to a second server it used to refuse ("This
  computer could not be set up"), because the daemon settings in `~/.reemoat` named
  the first. Each account now gets its own daemon, database, sessions and working
  copies — `~/.reemoat` stays with the server its `daemon.env` names, a server's
  first account otherwise lives under `~/.reemoat/servers/<server>/`, and each
  further account on a server under `~/.reemoat/servers/<server>@<user id>/`, on a
  port the system picks. Every account that is set up has its daemon started when
  the app opens, and all of them stop together when it quits. Switching accounts
  interrupts nothing: the other account's daemon, its running turns and pending
  approvals, and a phone's way to this computer through it stay up while the app
  runs. A new account's daemon starts empty — no plugins, system keys, custom agents
  or pasted keys of its own — while the agent CLIs' sign-ins are shared by every
  account. `REEMOAT_AGENT_UPDATES`, `REEMOAT_AGENT_SOURCE` and
  `REEMOAT_AGENT_CHANNEL` in `~/.reemoat/daemon.env` do not yet reach the daemons
  for other servers and accounts.
- **A daemon running here for this server that the app did not start is no longer
  met with silence.** One whose machine is in your list is adopted as before; one
  your account cannot see is named in the setup notice.
- **The app no longer creates a second machine for a daemon already running on
  this computer** with its settings file somewhere else (`REEMOAT_ENV_FILE`,
  `pnpm daemon` from a checkout); it adopts it.
- **A daemon's clean stop no longer deletes another daemon's announcement.** Every
  daemon removed `daemon.json` on its way out, whoever had written it; now only the
  one that wrote it does.
- `install.sh --uninstall --purge` names the desktop app's daemons for other
  servers and accounts before deleting them, and `--uninstall` lists them among the
  data it keeps.
- **The model chip read "Newer version availa…" after Claude Code moved its
  `opus` alias.** Claude Code 2.1.280 describes a conversation resumed on a model
  an alias has since moved past with a notice instead of the model's name, and the
  chip showed the start of that notice. It now shows the model the row names,
  "Opus 5". The notice stays in the menu under that row, where it tells you to pick
  Opus for Opus 5.5.
- **A Claude Code update the daemon did not install was picked up only ten minutes
  later.** When something other than the daemon updated the CLI (its own updater,
  another daemon, or `deploy/deploy.sh`), the new-agent screen kept naming the
  previous build, and listing its models, for up to ten minutes. The daemon now
  checks which file it would run each time it uses it, so the new build's version
  and models appear the next time you open the new-agent screen. A session that is
  asleep still shows its old list until it wakes.
- **The Android app would not install on a OnePlus 13 by tapping the APK.** The
  phone's own installer — OxygenOS, Android 16 — answered "App not installed as
  package appears to be invalid", while the same file installed on a Pixel, and
  over `adb` on that very phone. The APK carried only the signature Android has
  checked since 7.0; it now carries the older JAR signature beside it, which
  Android ignores and which that installer *may* have wanted. That is a
  hypothesis rather than a finding: the message is the one Android's own
  installer shows when the platform refuses a package, and the platform never
  reads a JAR signature beside the newer one. This release installing on a
  OnePlus would not settle it either, since the download and the build change
  too; the same APK signed twice with one key, with and without the JAR
  signature, and tapped on that phone, does. A release now also refuses to
  publish an APK missing either signature.
- **Starting a session in the macOS app put blank "exec" icons in the Dock.**
  Every MCP server an agent started through `npx` appeared there as an application
  of its own — a blank tile labelled "node" — because macOS counted the Node
  runtime inside the app as part of Reemoat itself. The runtime now lives in a
  small helper inside the app that macOS keeps out of the Dock, so MCP servers run
  exactly as before and the Dock shows Reemoat alone. The app is no larger: it
  still carries one copy of the runtime.

## [0.10.1] - 2026-09-22

### Added

- **The app, for five platforms, on the release page.** macOS for Apple silicon
  and for Intel, Linux as a `.deb` and an AppImage, Windows as an installer, and
  Android as a signed APK. Each is built on every push by a check that builds
  exactly the bundle the release publishes, and a platform cannot be added to a
  release without one.

### Fixed

- **0.10.0 has no release page, and this is the release it should have been.**
  0.10.0 was tagged and its control-plane image published, but its release failed
  while building the Linux app, so none of the apps were published and there are
  no 0.10.0 downloads. The code is the same: everything listed under 0.10.0 below
  reaches the apps here for the first time.
- **A release that failed still published its image.** The image tags people
  pull — the version's own and `latest` — were created as soon as the image was
  built, whether or not the apps built, which is how 0.10.0 ended up with an image
  and nothing else. They are now created only after every app has built, so a
  release that fails leaves nothing behind and can simply be run again.
- **The Linux app could not be built by a release.** The check that builds it on
  every push installed the system libraries it links against; the release job that
  builds the same app did not. Both now install them from one list.

## [0.10.0] - 2026-09-22

### Added

- **Grok, as a fifth harness and an eighth provider.** `grok agent stdio` is xAI's
  own ACP entry point, so this is the first agent that needs no adapter of any
  kind — `deploy/agents.sh` installs `@xai-official/grok` from the npm registry
  under either `REEMOAT_AGENT_SOURCE`, which is the door the daemon can refresh on
  a timer with nobody watching. A new `xAI` provider sits beside it, reached by the
  CLI that ships for it; a routed arm, letting Claude Code be pointed at Grok, is
  deliberately not included until one call with a real key shows xAI's
  `/v1/messages` answering in Anthropic's shape.
- **ACP `authenticate` is sent, for the harnesses that need it — and only where
  there is a key to spend.** A machine holding a pasted xAI key needs that call
  for the key to be spent at all, so the daemon makes it once per agent process,
  between the handshake and the first session. The method id is written down
  rather than read off the agent, because the one the agent advertises opens a
  browser and waits.

- **Agents are installed when you ask for them, not when the daemon updates.**
  A harness you have never used is no longer downloaded onto your machine: a fresh
  install brings none at all — several minutes and about 700 MB lighter — and a
  daemon update moves only the copies that are already there. To add one, open
  Settings → Agents, press **Install**, and watch it go; signing in comes after.
  A machine set up by a script can still name what it wants up front, with
  `--install-agents claude,codex`.

### Changed

- The model and reasoning-effort controls, the permission cards, resume and every
  other per-agent surface needed no new code for Grok: it publishes its controls
  under the same categories the existing agents do, and they were already read by
  category rather than by name.
- Grok is always spawned with `--no-auto-update`. It updates itself in the
  background otherwise, and when a build moves on a machine is this daemon's
  decision — it deliberately keeps the build a live session is running on.

- **A tag can publish the app, and the machinery is in place before any platform
  uses it.** `deploy/ci-release.sh` grows a fifth verb, `app`: it builds the
  native app for one target, refuses a target no check has built, refuses a
  client build with a daemon payload left on the runner, refuses a bundle that
  was not produced or was produced twice, and names the artifact it copied out.
  `publish` puts every one of them on the same `gh release create` call as
  `install.sh` and **refuses a release missing an artifact its own list named** —
  by name, never by count. Thirty-six new assertions in `pnpm deploycheck`
  drive all of it with no forge, no registry and no bundler.
- **Which platforms carry a daemon inside them is written down per platform.**
  `tauri.linux.conf.json`, `tauri.windows.conf.json`, `tauri.android.conf.json`
  and `tauri.ios.conf.json` remove `externalBin` and `resources`, so every
  platform but macOS ships a client. Measured rather than assumed: `tauri-build`
  reads those overlays at **compile time**, which is what makes a client build a
  configuration file with no Rust in it. `pnpm nativecheck` holds an overlay to
  an exact allowlist of keys, because it reads one configuration file and Tauri
  reads five.
- The release notes now carry the AGPL §6 source offer for the tag being
  released. `bundle.licenseFile` is read by the `dmg` and `nsis` bundlers and by
  nothing that builds a macOS `.app`, so the artifact most people download would
  otherwise carry neither a licence nor an offer.

### Fixed

- **A new agent appeared on machines that did not have it, offering to sign you
  in.** Adding a coding agent to Reemoat put it on every machine in a fleet on the
  next daemon update, and the button under it led to a screen that could only
  report that the program was missing. Nothing installs an agent by itself any
  more, and where one is genuinely absent the screen offers to install it rather
  than to sign in to it.
- **Grok could not run a turn on a machine signed in with `grok login`.** The
  first message came back as a bare `Internal error`. The `authenticate` above was
  being sent unconditionally, and with no API key behind it that call does not
  fail — it *selects* an API-key sign-in, after which Grok stops consulting the
  credential it already has and calls its own service as nobody. It is now sent
  only when there is a key to spend, so a machine signed in the ordinary way uses
  the credential it has.
- **Grok's tile offered "Sign in" on a machine that was already signed in.** The
  daemon had no way to ask Grok about its own sign-in, so every machine answered
  "cannot check". It asks now, and tells the three states apart: signed in through
  the browser flow, running on a saved key, or signed in nowhere.
- **A greyed *Mode* control on Grok said the agent was "not offering this control
  at the moment".** Grok has no modes at all and never will, so the sentence was
  describing a permanent fact in words that promised a temporary one. The slot
  still holds its place — the control row is the same shape on every agent, which
  is deliberate — and now says the agent has none.
- **A provider whose models come from a coding CLI vanished from the model picker
  in silence when that CLI could not be reached.** Five of the eight providers get
  their model list from the harness that ships for them, so a CLI that is missing
  or will not start took its whole provider off the screen with nothing said, and
  the only available conclusion was that the product had dropped it. The picker
  now says which providers it could not read, and why.

- **Android is compiled and assembled by CI now, and both halves were dark.**
  `check.yml` grows `native-android`, which compiles the Rust for
  `aarch64-linux-android` — measured green, with the negative control that an
  error inside `cfg(target_os = "android")` fails it while `cargo clippy
  --all-targets` on the host stays green — and `android-apk`, which runs Gradle,
  assembles a release APK and then reads `classes.dex` to prove the TLS
  verifier's Kotlin half survived R8. That last one is the assertion no regex can
  stand in for: a keep rule that is present and ineffective looks identical from
  the outside. `android-apk` needs `gen/android` committed, which `.gitignore`
  has always said it should be.
- **The Android arm of the Rust was compiled by nothing, and a shipped APK could
  not do TLS.** `cargo clippy --all-targets` is every *crate* target on the host,
  never another platform, so `credential.rs`'s Android half and its JNI export
  were checked only by `nativecheck` regexes. R8 then stripped
  `org.rustls.platformverifier` — the class the Rust TLS stack reaches over JNI
  by name — out of the signed release APK: measured against the built artifact,
  where `usage.txt` listed all five classes removed and `classes.dex` carried
  none, while the `.so` still carried the name it would look up. Debug builds
  were unaffected, which is what made it invisible. There is a keep rule now,
  `nativecheck` asserts it paired with the Gradle dependency that puts the class
  in the APK at all, and a `native-android` job compiles the arm on every push.
- **A typo in `RELEASE_APP_TARGETS` published a release with that platform
  silently missing.** `app_artifacts` refuses a name the table does not know by
  returning 1 — inside a pipeline, with no `pipefail`, so `set -eu` never saw it
  and the name contributed no asset at all. `plan`'s collision gate and
  `publish`'s completeness gate then had nothing to find. Every name is checked
  against the table now, by `plan` and `publish` directly rather than from inside
  the `$( )` that made the first attempt at this equally silent.

- **A mobile build would have compiled and then silently never kept a sign-in.**
  `keyring`'s `v1` feature has no credential store on iOS or Android — it refuses
  at run time having compiled perfectly — so an APK or an `.ipa` built today would
  have asked for the password on every launch. Android now reaches past that
  façade to `keyring-core` with `android-native-keyring-store`; iOS is refused at
  compile time until its own arm is written, because everything else a mobile
  build is missing already fails loudly and this one would not.
- **The bundled payload's `node` shim could re-exec itself for ever.** Its last
  line was `exec node "$@"`, and the daemon's own `PATH` puts that shim's
  directory first — so on any layout where its two relative probes miss, a PATH
  lookup for `node` found the shim again. It says what happened and exits 127
  now. Reachable on a `.deb` or an AppImage, where it would have read as a
  daemon that never starts.

- **Selecting a message selected the empty space around it too.** Dragging through
  a conversation painted one solid rectangle: the unused half of every short line,
  the gap between paragraphs, and the whole blank column beside your own message.
  Only the text is painted now — every line, every gap, both sides of the
  conversation — and what gets copied is unchanged to the byte.
- **A line break you typed was thrown away when the message was sent.** It was
  never lost on the way out; a single newline is a *soft* break in the markdown
  everything here is rendered as, so it was collapsed into a space when the
  message was drawn. Your own messages keep their breaks now, and every message
  already in a conversation gets its breaks back on the next draw. An agent still
  gets CommonMark, which is what it writes.
- **The ✕ in the background-tasks panel lit up before the pointer reached it.**
  Several controls grew an invisible margin so a finger could hit them, and that
  margin was there on a desktop too — where it is not a bigger target but a
  control that reacts to the wrong place. It is now added only where the pointer
  is coarse.
- **A failure count sat in the same fill as the message above it.** `1 failed`
  was drawn as a pill in exactly the colour a person's own message uses, so it
  read as part of it. It is quiet text aligned to the message now.
- **A session could say "working" for hours after its agent had finished.**
  `claude-agent-acp` can start a turn on its own coming back from background work,
  and a turn nobody asked for has nothing to end it — so the daemon sat on a
  request that would never be answered. Three hours of silence from the agent now
  ends such a turn, and a message you send does not reset that clock.

## [0.9.1] - 2026-09-18

### Changed

- **Traffic to a remote daemon is end-to-end encrypted, and there is no other
  mode.** The app and the daemon run `Noise_IK_25519_ChaChaPoly_BLAKE2s` between
  themselves: the app's static is a per-installation **device key** kept in the
  operating system's keyring and used from Rust, the daemon's is a **machine key**
  it generates on first start and announces on its tunnel dial. The relay
  authorizes the connection and then carries bytes it holds no key for — prompts,
  diffs, file contents and terminal output are ciphertext to it. Every capability
  names the device it was minted for, so one stolen off the wire or out of a log is
  worth nothing from anywhere else.
- **The relay's plaintext proxy is deleted.** It used to serialize each request
  onto the tunnel with Node's own HTTP client and copy the answer back, which meant
  it held the plaintext of everything in the fleet. Both handlers are refusals now.
- **This is a flag day, taken deliberately.** `RELAY_PROTOCOL_MIN_VERSION` is 2, so
  a daemon that has not been updated stops dialling in and is refused with a `426`
  naming what to do. Its machine draws as offline until `deploy/deploy.sh` runs on
  that host. No range can span "plaintext HTTP" and "ciphertext", which is what the
  version range normally exists to avoid.
- **The shell is the shape of a chat client now, on both axes.** Below `lg` the
  machines are a horizontal strip of underline tabs above the session list; at `lg`
  and wider they are a 72px column of folders down the left, drawn from the same
  `machineTabs`/`allTab` source and carrying none of the strip's three cues. The
  rail is the two of them on one `--rail-w`, draggable, bounded in one place.
- **`ProfileMenu` is gone and a menu drawer replaces it.** Who you are, where you
  can go and what build you are running, in a panel that **covers** the app rather
  than docking beside it — registered as a sheet, so `j`/`k` cannot walk the list
  behind it. The visible wordmark left the chrome with it: the drawer's foot draws
  the build, and the `<h1>` on the list column stays `sr-only` for the heading
  order `Header.tsx` rests on. The build string is read from `packages/web`'s own
  manifest at build time rather than written down an eighth time.
- **The agent's controls survive a reload.** The daemon deliberately restores no
  `agentConfig` from disk and empties it while an agent is away, so `F5` used to
  cost you a strip of three dashes on a session whose model and effort were on
  screen a second earlier. This tab now remembers the last set a *running* agent
  published — the selected choice only, 120 sessions, bounded on write — and draws
  it dimmed and untappable. ⚠ **It does not put the settings back on the agent**: a
  restart still comes back on the agent's own defaults, and nothing read back from
  the memory is ever sent. It is cleared on sign-out, both ways out.

### Removed

- **The browser branch of the app.** A browser holds no device key, so it cannot
  open an encrypted channel to a daemon — it could load the client and reach no
  machine at all. Gone with it: the Telegram mini app, and `REEMOAT_CP_WEB`, which
  named a built copy of the app for the control plane to serve. The **gate** —
  sign-up, the mailed-link screens, the legal documents and the handoff page — is
  unaffected and still served to a browser, because every one of those flows begins
  in a mail client and has nowhere else to land.
- **`pnpm client` can no longer reach a machine through the relay.** Opening a
  channel needs a device key and a capability bound to it; `REEMOAT_TOKEN` is a
  long-lived bearer capability with no binding, which is exactly what the binding
  makes worthless. It refuses with a sentence naming the remedy — the app for a
  remote machine, `REEMOAT_URL` for a daemon on this computer.

### Added

- **Reemoat runs as a native macOS application.** `packages/native` is a Tauri 2
  window around the existing web client, built once and **embedded in the binary** —
  so the control plane it supervises serves it no JavaScript and cannot replace any.
  It asks which server to connect to, signs in through the same routes the browser
  uses, and keeps the session in the operating system's credential store rather than
  in browser storage, keyed on the server's origin so two servers can never share
  one sign-in. Windows and Linux are structurally supported and iOS and Android are
  prepared; `docs/NATIVE.md` has the prerequisites, what signing and notarization
  would take, and what is deliberately not built.
- **The same bundle, not a second copy.** There is one `packages/web` and no
  `@tauri-apps` dependency anywhere in it: the shell injects one function and the
  app reads it through a hand-written bridge.
  Every screen, every retry rule, the WebSocket, the cursor and the upload progress
  are the code the browser client runs. One leg differs — `/v1/*` goes through the
  host process, because the control plane mounts no CORS and adding one to serve a
  client that does not need it would be the wrong repair.
- `pnpm nativecheck`, and a `native` CI job for the parts that need a Rust
  toolchain. Nothing about the native app builds, signs or publishes on a push.
- **`pnpm protocolcheck`, and it is the only driver here whose subject somebody
  else wrote.** Every other check asserts a decision this repository made; this one
  asserts that our handshake produces the bytes the Noise Protocol Framework says it
  should, driven against the published cross-implementation vectors in both roles
  with the ephemerals pinned. An implementation that only ever talks to itself
  round-trips perfectly while interoperating with nothing, and would go on doing so
  through a nonce written big-endian or a protocol name hashed where it should have
  been padded — none of which a self-test can see. It also covers the two things the
  specification leaves to us: the reserved top of the nonce range, where the guard
  was `>` and had to be `>=`, and this repository's own frame table. With it and
  `nativecheck`, the drivers that run offline in one process go from eight to
  **ten**.
- **The app reaches a daemon on the same computer without going out to the relay
  and back.** A daemon that has been enrolled writes where it is listening into
  `~/.reemoat/daemon.json` when it starts — its machine id, a loopback address and
  the port it actually bound — at `0600` inside a `0700` directory, and removes it
  on a clean stop. The app reads that through the host process and proves the
  daemon is the machine it wants with one authenticated request before it sends
  anything else. Nothing to configure: a daemon on a custom port, or on one the
  kernel picked, is found the same way, and a daemon that has not been enrolled
  announces nothing at all.

  It is on by default and switched off per machine in Settings → Machines → *This
  device*, which is also where the one cost is stated: the relay is what checks a
  grant is still live before each request, so on this path a grant the owner takes
  away keeps working from that computer for up to about six minutes. Everywhere
  else it stops at once. Only a program running as the user who owns the daemon can
  take the path at all — which is a user who already has that daemon's database.

  Nothing above the transport changed. The same session API answers on both paths,
  no screen knows which one replied, and a browser cannot take the local one.
- **An instance serves the API, the relay and the gate, and no app interface at
  all** — now the only shape rather than a documented option. Every `/v1` route,
  `/health`, `/install.sh`, the relay and the tunnel behave as they always did, and
  an address outside the gate's nine gets the error envelope every other refusal
  answers in rather than a page. `docs/API.md` has the table and `deploy/README.md`
  has the operator's version.

### Fixed

- **A security assertion had gone quiet over exactly the commands it guards.**
  `webcheck.devices.ts` swept `#[tauri::command]` bodies by matching that literal
  including its closing bracket, so the twelve commands that gained `(async)` fell
  out of it — among them every one that touches a device key. The check that the
  browser-facing page cannot obtain the X25519 private key was being evaluated over
  seven commands that were never going to touch it. Its floor, `> 5` against an
  actual 7, could not notice: a skipped body does not lower a count, it fails to
  raise it. The pattern takes both spellings now and the floor is replaced by a
  **census** — bodies differenced against attribute occurrences — so a third
  spelling is a red build rather than a silent gap, plus a named list of the
  device-key commands that goes red naming whichever went missing. The same sweep
  also found three source slices whose `indexOf` end anchor, when absent, made
  `String.slice` read `-1` as counting from the end: the slice did not empty, it
  ran to one character short of the file, so `writeStored` was 4,078 characters
  becoming 32,958 with its own length floor still printing `ok`.

- **An unreadable `server.json` was still overwritten, and the comment above it
  said otherwise.** The quarantine added for a corrupt config ran only on the
  *parse* branch; a file that exists and cannot be read — a permission, an I/O
  error, a damaged volume — answered `Default` and the next write renamed a fresh
  empty config over it. On a keyring-less host that is the only copy of the device
  private key. A write that cannot preserve what is already there now refuses
  before creating anything, and the refusal names the path.

- **A remote transcript stalled for good on a large session, and nothing logged
  it.** `StreamConnection.flush` cut its outbound batch on `estimateBytes`, which
  charges `String.length` — UTF-16 units of the *unescaped* string — while the wire
  carries `JSON.stringify` as UTF-8. `MAX_SOCKET_MESSAGE_BYTES` (1 MiB) is enforced
  by the receiver and nothing enforced it at the sender, so a batch charged under
  the 512 KiB ceiling could be several times that: measured 3,026,371 bytes for 21
  events of escape-heavy text, which is what a coding CLI's stderr is made of (one
  charged unit escapes to `\u001b`, six bytes). The far end refused the message,
  the channel failed, and the app reconnected with its cursor unchanged onto the
  same batch — for ever. `flush` now encodes each event once and cuts on
  `Buffer.byteLength`, keeping the unconditional first event so a single oversized
  event is still sent alone rather than wedging the queue. Held by two new
  `daemoncheck` sections driven on the *direct* path, because over a channel the
  overflow is answered by `fail()`, which ends the stream — so one frame crosses
  either way and no count taken at the peer could tell a refusal from health.

- **A control frame too large to send wedged the attach before it started.** The
  batch ceiling above is about a transcript stalling partway; `hello` is the first
  frame of every attach and carries the session snapshot, so a frame over the
  reassembler's bound means the transcript never starts and the reconnect rebuilds
  the same frame. It is now fitted by a two-rung ladder — blobs emptied, then the
  pending lists halved, each rung re-measured on real UTF-8 bytes — and a frame
  neither rung can shrink is still **sent**, because a `hello` that never arrives
  is the stall rather than the cure. `fitSnapshotFrame` is exported for the driver
  and for nothing else: every rung is reached only by a snapshot no offline fixture
  can assemble, and measured, deleting the function outright left every driver in
  this repository green.

- **The sign-up bundle shipped a Noise implementation it is structurally incapable
  of using.** One import edge — `gate-main.tsx → store.ts → machine.ts → e2ee.ts →
  `@reemoat/protocol`` — put the handshake, the cipher state and the frame codec on
  all nine gate addresses: a registration form, four mailed-link screens a mail
  client opens (typically on mobile data), three legal documents and the handoff
  page. A browser holds no device key and `dist-gate` has no session view, so not
  one of those pages can open a channel. It had grown from 266 kB to 335,745 bytes
  (106.31 kB gzipped) in two days with nothing measuring it. The gate reads a
  narrower `gateStore` now, and `ui/SignIn.tsx` — the one shared box that also has
  to *act* — reaches its store through `signInAuth.ts` rather than naming either:
  232,490 bytes, 72.91 kB gzipped, with no Noise string and no ed25519 constant in
  any emitted asset. `webcheck` walks the **value** import graph from each entry and
  refuses a transport module in the gate's; it has to be the value graph, because
  `ui/bits.tsx` type-imports `OfflineReason` from `machine.ts` and
  `verbatimModuleSyntax` erases that, so the broad walk reported a chain the bundle
  does not contain.

- **A refused encrypted session went on acting on the peer's next frame.**
  `fail()` guarded on `closed`, which it deliberately does not set — it leaves the
  session up long enough for the `FAILED` frame to flush — and `consume`'s loop
  guard read the same flag. So every frame already pulled out of the same TCP chunk
  was still decrypted and dispatched after the refusal. Measured: a `REQUEST_BODY`
  the daemon refused, followed in the same chunk by an `OPEN`, upgraded a real
  WebSocket on a session the daemon had just refused to carry.

- **A daemon that answered before reading a body tore down the app's session.**
  `REQUEST_BODY`/`REQUEST_END` were the only frame arms that never consulted
  `carrying`, so a peer could write into a finished request's orphaned
  `ClientRequest` — which on a keep-alive socket whose server has already answered
  is what a pipelined request is made of. Closing that by refusing the frame broke
  an ordinary client instead: the app's send loop exits on a failure or a close and
  `RESPONSE_END` is neither, so `uploads.ts`'s per-session cap, its rate check and
  any 401/404/405 on a `body: true` request left the app writing frames into a
  connection whose `carrying` had already gone back to `"none"`. Reachable by
  uploading one attachment past the cap with a body over 65518 bytes. A late body
  frame is dropped now, the way a `MESSAGE` that raced the daemon's own `CLOSE`
  already was, and the handle is `destroy()`ed at the end of the response so there
  is nothing writable left for the bytes to be smuggled onto. A body frame on a
  connection carrying a *socket* is still refused.

- **A cancelled upload went on encrypting the whole remaining file and ran its
  progress bar to 100%.** `close()` deliberately does not set `failure`, and
  `failure` was the send loop's only exit, so an aborted or timed-out request kept
  iterating — `drain()` returns at once once closed, so it ran flat out, sealing
  every remaining 65518-byte chunk with ChaCha20-Poly1305. On the phone this client
  is shaped around.

- **The app→daemon socket direction had no backpressure, and it defeated the
  ceiling that was already there.** On the direct path a stalled client raises
  `bufferedAmount` past `SOCKET_HIGH_WATER` and `MAX_QUEUE_BYTES` eventually
  collapses the socket; on the encrypted path the loopback `ws` client drains
  greedily, so that ceiling never fired and the bytes piled up in the relay
  Duplex's unbounded buffer instead, inside the process that owns the machine's
  live agents.

- **A request whose answer came back before its body ended leaked a loopback
  socket for two minutes.** `response.on("end")` released the handle, putting it
  beyond `destroy()`'s reach with nothing else coming to collect it — one orphan
  per 404, 401, 405 or early 413 on a `body: true` request, on a connection the
  app's pool had already been told was idle.

- **Two daemons starting at once could mint two machine keys, which is a permanent
  409.** `claimDaemonLock` was a non-transactional read-then-write, and the
  `ON CONFLICT DO NOTHING` that looked like it absorbed the race could not: the
  conflict key hashes the *freshly generated* key, so two racers produce two keys,
  two thumbprints and no conflict. `active()` orders by `created_at DESC`, so the
  next start announced the later key, disagreed with what the Authority had pinned,
  and was refused at every dial — repairable only by `cpctl admin clearkey`. The
  claim is a compare-and-swap now, and a partial unique index over
  `retired_at IS NULL` is what lets the loser learn it lost and adopt the winner's
  row. The index is created by `migrate()` rather than by `schema.sql`, after a
  repair, because databases holding two live rows exist and a `CREATE UNIQUE INDEX`
  at schema load would stop those daemons from ever starting.

- **The device key could still be lost whole on a crash, and a corrupt config was
  destroyed rather than kept.** The temporary file was `sync_all`ed and renamed, but
  the parent directory never was, so the new directory entry was not durable — on a
  keyring-less host that is the only copy of the X25519 private key, and the
  installation comes back as a first run. An unparseable `server.json` answered
  `Default` and was silently overwritten by the next write; it is moved aside first
  now, and a field another build wrote survives a read-modify-write instead of being
  dropped. Read-modify-write is serialized, so adding `(async)` to a config command
  — which the module's own docblock encourages — cannot lose the key.

- `packages/web`'s three "add a machine" screens built their install command out of
  the page's own origin. In a browser that is the control plane and is right; under
  a custom scheme it printed a `curl` line naming the app itself. They ask where the
  control plane is now, and one of the three had never been asserted.
- **The native window would navigate to a control plane on loopback.** Its
  navigation guard allowed `http://localhost` and `http://127.0.0.1` in every build,
  for the Vite dev server — and a Reemoat control plane on loopback is the ordinary
  self-hosted shape, serving its own page at `/`. A script assigning `location.href`
  could therefore have replaced the running app with the backend's page, inside the
  window holding the sign-in: the one thing bundling the interface exists to make
  impossible. Those two are development-build only now, and every navigation the
  client itself makes is asserted to be a path rather than an address.
- `REEMOAT_CP_INSTALL` is documented for the first time — it appeared in no example
  file anywhere. It is also the only variable left whose value is *either* a boolean
  *or* a path: the other one answered `=1` with a directory called `1`, ENOENT, and
  a 404 indistinguishable from an image built without the interface, and it is
  deleted rather than fixed.
- **The device key's fallback file was world-readable, and two docblocks plus
  `.claude/rules/e2ee.md` said it was not.** Where the operating system's keyring will not hold a key —
  a shared Linux host, a session with no unlocked collection — the native shell
  keeps the X25519 private key in `server.json` instead, and that file was written
  with `fs::write`, which creates at `0644` under the usual umask and, on a file
  that already exists, keeps whatever mode it already had. So the protection was
  described in three places and implemented in none, on precisely the machines that
  have somebody else logged into them. It is written through a temporary file
  created with `OpenOptions::mode(0o600)` and renamed over the target now: the mode
  at creation closes the window in which the bytes exist at the umask's, and the
  rename is what narrows installations that already exist — a fix that only set a
  mode at creation would have looked green in a test starting from an empty
  directory while leaving every machine in the field as it was. The same write also
  stops truncating in place, which on those hosts could lose the only copy of the
  key, the server origin and the device id in one act. `cargo test` asserts the
  mode, the upgrade path and the directory's `0700`.
- **The documentation described the release before this one.** `README.md`'s
  overview — the first screen anybody reads — still offered the web UI as an
  optional second client, which this release deletes; `docs/API.md` still pointed
  HTTP clients at the plaintext relay proxy, which now answers `426` to every
  request, and still credited `pnpm client` with driving routes whose relay arm went
  with it. Both are rewritten around what is actually there: the app, the encrypted
  channel at `/__relay/channel`, and the gate as the whole of what a browser
  reaches. `POST /v1/tokens` gains the two things a client cannot open a channel
  without — `machine.key` and the `409 device_key_required` refusal — neither of
  which was written down anywhere a caller would look.
- **The rules table had thirty rows for thirty-one rule files, and the missing one
  was `e2ee.md`.** A rule arrives when a file matching its globs is opened, so the
  table is not an index of them — but it is how anyone deciding what to read finds
  out an area has a rule at all, and the area it was silent about was the newest and
  the most security-critical. `.claude/rules/compatibility.md` is rewritten around
  the fact that replaced its premise: the client used to ship inside the control
  plane's image, so skew ran one way and a weekly deploy retired the oldest clients
  in the fleet by itself. Nobody can push a client any more. It also now records an
  open question rather than answering it — `packages/protocol/src/frames.ts` is
  spoken between two independently shipped artifacts, carries no version between
  them (the suite string on the CONNECT is written by the relay, which speaks none
  of that protocol), and treats an unknown frame as fatal at both ends.
- **`.claude/rules/e2ee.md` credited a check to the wrong driver, in the direction
  that gets a check deleted.** `RELAY_CHANNEL_PATH` is a literal in the relay and a
  second literal in the app — they cannot be one import — and a client dialling a
  path the relay does not serve is a fleet where no machine is reachable. Three
  docblocks said `relaycheck` compares them. It does not: it imports the relay's own
  constant and never opens the app's file, so every path it dials is one constant
  agreeing with itself. `packages/web/scripts/webcheck.e2ee.ts` is the only
  comparison there has ever been, and the rule says so now — the danger was never
  the missing check, it was that believing in a second one makes the first read as
  redundancy.

## [0.9.0] - 2026-09-14

### Added

- **A message sent while the agent is working is taken rather than refused.**
  Correcting an agent mid-run no longer means pressing Stop and losing whatever
  the turn had half-done. Where the agent supports it — claude and codex, over
  the `_session/steering` extension they advertise on `initialize` — the message
  goes straight into the turn already running. Where it does not, the daemon
  holds the message and hands it over the moment the turn ends, and the
  transcript says so under the message. The queue is the daemon's, so it survives
  a closed tab, a sleeping phone and a dropped connection; it does not survive a
  daemon restart, and a session stopped with messages still waiting records that
  they never arrived.
- `POST /sessions/:id/prompt` answers `202` for a message sent mid-turn, carrying
  `steered` or `queued` beside the usual `seq`, where it previously answered
  `409 turn_in_flight`. A daemon that has not been updated still answers the
  `409`, and the web client keeps its old behaviour against one.

- **Work an agent leaves running after the turn that started it is visible, and
  can be stopped.** A backgrounded shell, a monitor or a workflow used to end
  with the tool call that started it — the card read `completed` while the
  command ran on for minutes, and nothing in the app could say what was still
  going. The transcript's still-working row is a control now, and it opens a
  `Background` panel: a bottom sheet over the conversation on a phone, docked
  against the right edge on a wide screen, with a card per task carrying what it
  is, how long it has been going, what it has spent, and Stop wherever the agent
  says the task may be stopped. A tool call that detached says `Running in the
  background` instead of reading as finished.

  It rides `jetbrains.air`, which is a **vendor `_meta` extension rather than
  core ACP** — the draft surface for `agent-client-protocol#1992` — declared on
  `initialize` and answered by claude alone. Measured 2026-09-11 against claude
  2.1.268 under claude-agent-acp 0.73.0; **the other three agents send nothing
  here.** kimi backgrounds shells, agents and cron jobs and maps its own
  terminated event nowhere, codex's `unified_exec` PTY outlives the call it was
  made in with no push at all, and opencode's `bash` tool has no background flag.
  So an empty panel says *which* emptiness it is: `No tasks currently running` is
  only sayable about an agent that would have told us, and the other three get a
  sentence naming the silence instead.

  Three limits, stated because each of them is somebody's build. A session
  **claude reports live work in** is not parked by the idle sweep and is not the
  one released when a machine hits its ceiling — the work outlives the turn, so
  the half-hour that is enough for an idle conversation is not enough for this
  one. That protection is exactly as wide as the signal it rides: the other three
  agents report nothing, and even under claude a backgrounded *subagent* is
  announced as nothing at all, so for those the only thing standing between a
  build and a released agent is still the floor on how young a session may be and
  still be taken at the ceiling — two minutes. **Nothing here survives a daemon
  restart**: a resumed session starts with an empty set, and the transcript
  carries a row saying how many tasks were running when the agent was shut down,
  because the tasks themselves went with the process. And a `/clear` closes the
  ACP session those tasks belonged to, which is what ends the shells it was
  holding — a rung below that nothing here can see, so the transcript claims only
  that the work was going and that this daemon can no longer say anything about
  it. The rows go with the conversation, and a row of its own says how many were
  going, since otherwise the only trace of a build somebody was waiting on
  vanishes with the panel.

- `POST /sessions/:id/async-tasks/:taskId/stop`, and `backgroundTasks` and
  `reportsBackgroundTasks` on the session snapshot. Stopping answers `200` with
  `stopped: false` when the task ended on its own between the tap and the request
  — that is an ordinary lost race, not an error — `404` for an id this session
  never announced, which is a different sentence, and `502` where the agent could
  not be asked at all, which is *nobody knows* rather than *it was already over*;
  the card says so where it was pressed. Both snapshot fields are optional on the
  wire, so a client reading a daemon that has not been updated draws exactly what
  it drew before any of this existed.

### Changed

- **The composer's send slot follows what you have typed rather than what the
  agent is doing.** With the box empty it is Stop, as before; with anything in it
  worth sending it is Send. Whitespace does not count, so a stray space or tab
  leaves Stop where it was.
- **The transcript's "still working" row opens the background panel rather than
  unfolding a list beneath itself.** It used to be a disclosure drawing the
  agent's outstanding delegations inline; two surfaces listing one set is how
  they come to disagree, and the inline one could not grow to hold a task card
  without pushing the composer down the screen every time an agent backgrounded
  a shell. The row keeps the job it was always good at — saying, in the
  conversation, that something is still going — and is pressable.

## [0.8.0] - 2026-09-11

### Added

- **Terms of Use, an Acceptable Use Policy and a Privacy Policy, at `/terms`,
  `/acceptable-use` and `/privacy`.** Readable with no account, because the sign-up
  form links to them and because they are the URLs somebody is given when they ask
  what the terms are. Signing up now needs a ticked box, which gates the form and
  is refused by `POST /v1/register` without an `acceptedTerms` field — but nothing
  is stored, so this instance still cannot prove what anybody agreed to and does
  not claim to. All of it is off unless `REEMOAT_CP_LEGAL_DOCUMENTS` says
  otherwise: an instance that has not claimed the documents draws no pages, no
  box, and refuses nobody. The
  documents are adapted from the 37signals policies (CC BY 4.0, credited on the
  page) and `github/site-policy` (CC0), and they name **one operator** — a fork
  must replace the `OPERATOR` block in `packages/web/src/legal/operator.ts`. English
  only.

- **An idle agent is now shut down and the conversation kept.** A session nobody has
  touched for `REEMOAT_IDLE_PARK_MINUTES` — 30 by default, on by default, `0` to
  switch it off — is stopped with a new `parked` exit reason: the process goes, the
  conversation, the worktree and the branch stay, and **the next message brings it
  back**. There is no Resume control for one, deliberately; the composer is the whole
  affordance. Measured before it was built: a resident agent is ~397 MB and comes
  back in ~1.3s at the median, so a machine holding three sessions nobody had opened
  in 48 hours was holding 1 384 MB to save that. It draws as an ordinary idle session
  and says nothing, Stop still works on it, and its model and mode chips stay live —
  a tap is recorded and applied when the agent returns.

- **`GET` and `PATCH /settings` on the daemon, and a control on the machine's
  settings screen** for the number above. A saved value **overrides**
  `REEMOAT_IDLE_PARK_MINUTES`, which is therefore the default for a machine nobody
  has set; it takes effect without a restart. The daemon's configuration is still env
  only — this is the narrower class of setting whose owner is the person using the
  machine rather than the one who deployed it.

- **`parked` joins the `SessionStatus` and `ExitReason` unions**, and it is neither
  `interrupted` (the daemon owes it back by itself) nor `exited` (somebody ended it).
  A client older than this release has never heard of it; it keeps the composer and
  reads the session as live, which is the safe direction, but it will label the exit
  `ended: parked`. Deploy the control plane, which carries the web client, before the
  daemons.

- **Give up a share somebody made to you** — `DELETE /v1/machines/:id/grants/me`,
  driven by `cpctl leave <machineId>`. Sharing writes a permanent row for any user
  id with nothing asked of the person named, and the three verbs beside it all
  resolve through ownership — so until now the only account that could undo a share
  was the one that made it. Your own grant only, and never on a machine you own:
  the machine list is a join over `grants`, so an owner without one would own a
  machine that appears in no list. Retiring it is the verb for that.
- **Share a machine you own** — `GET` · `PUT` · `DELETE /v1/machines/:id/grants`,
  driven by `cpctl shares` / `share` / `unshare`. The other person is named by
  **user id**, which they read off `cpctl me` and tell you: there is no directory
  an ordinary account may read, and a name lookup here would be a way for anyone
  signed in to test whether an account exists. Your own grant is refused on both
  writes — narrowing it would take `machine:admin` off your own hardware, and
  removing it would hide the machine from its owner. Retiring the machine is the
  verb for giving up your own access.
- **`enrolledBy` on `GET /v1/machines`**, and drawn on the machine row: whose
  enrollment code a machine enrolled with, when that was not yours. It is the
  disclosure for a composition no single refusal closes — revoke somebody's
  machine, register a new one under the name that frees, enroll it on your own
  hardware, and their list draws the name they lost, owned and online. Every step
  has to stay, so the composition is made visible instead. A name is something to
  recognise rather than an alarm: the installer's wizard enrolls on an admin's
  code too.

  Machines that enrolled **before** this column existed — which on the day of the
  upgrade is all of them — say *somebody this control plane did not record* rather
  than nothing, because nothing is what a machine you enrolled yourself draws and
  folding them together would have left the disclosure silent for exactly the
  population it is for. There is no backfill: the table it would read from is swept
  seven days after a code is used.

  Two limits, stated because a disclosure nobody has bounded gets trusted past what
  it says. It names who **minted** the code, never who redeemed it — `POST
  /v1/enroll` is public and a daemon presents no account, so a code of your own
  that leaks and is redeemed elsewhere reports you. And it moves when the machine
  list is read, on a wake or a reload, not on the four-second poll.
- The session rail is ordered by you. Grab a chat with the mouse and drag it up or
  down inside its folder; on a touch screen hold it briefly first, so the gesture
  and scrolling the list stay apart. Drop it in Pinned to pin it, and drag it back
  out to unpin. `Alt`+`↑`/`↓` on a focused row does the same from a keyboard. The
  order is stored per machine on the daemon, so one set from a laptop is the one a
  phone opens.
- **Up one folder** in the New session directory picker, beside the path — a 44px
  square with a ground of its own, sized for a thumb. Always drawn and greyed out
  at the top of the tree rather than appearing when it becomes usable; the path
  itself is still tappable segment by segment.
- A way back from **Import code**. Its ✕, Escape and a tap outside now return to
  New session with the machine, agent and folder still chosen, and there is a
  chevron that says where it goes. Closing it mid-upload also stops the upload,
  which used to hold the machine's import lock.
- A second control on the error screen: **Go to sessions**, beside Reload. A
  screen that throws every time it renders made Reload a loop.

- An instance can point somebody who has no machine at somewhere to get one.
  `REEMOAT_CP_MACHINES_OFFER_URL` in the control plane's environment takes an
  `https://` address, and the three screens that already print the one-line
  installer draw a second, quieter link beside it. Environment-only on purpose:
  it names one particular shop, and a runtime setting would draw it on the
  Server settings screen of every instance. **Empty by default**, and an instance that never sets it
  looks exactly as it did before. The signed-in person's email address travels in
  the link as `?email=`, so a checkout on the far side can prefill its own form;
  it goes only when they tap it, and every response here already carries
  `referrer-policy: no-referrer`, so nothing else about the instance goes with it.
  The address is configured rather than compiled in because this is AGPL software
  and forks run their own control planes.
  The offer is drawn only where a machine may still be added: at or over the
  machine limit a bought host would be refused at the dial, so offering one there
  would sell something this control plane will not connect.

### Changed

- **A machine at its session ceiling now releases an idle agent instead of refusing.**
  `POST /sessions` and any wake take the least recently used **idle** slot rather than
  answering `429`, and a turn in flight, an unanswered permission and an unanswered
  question are never taken at any ceiling. A create is still refused when every live
  session is genuinely busy, and the sentence says so. The ceiling therefore counts
  agents resident rather than conversations held.

- **An admin may no longer mint an enrollment code over a live one somebody else
  made.** `POST /v1/admin/machines/:id/enrollments` answers `409 code_outstanding`.
  Minting supersedes the machine's current code, so on a machine that is owned but
  has not enrolled yet — which is what an install in progress looks like — an admin
  minting here killed whatever the owner was holding: their install failed against
  the deliberately undifferentiated `409 code_unusable`, nothing on their screen
  said why, and it could be repeated for as long as somebody cared to, because
  `enrolled_at` never left NULL and the guard beside it never started applying.
  The two uses that stay are the two it was for: `install.sh`'s wizard mints on a
  row that has no code at all, and an admin re-minting their own supersedes only
  what they are replacing.
- **Deleting an account no longer strands a machine it was the last person on.**
  `DELETE /v1/admin/users/:id` already revoked the machines the account *owned*; a
  machine it merely held a grant on was left ownerless, enrolled, dialling the
  relay and in nobody's list. That is the failure user-owned machines exists to
  remove, and it was also a way to *manufacture* the state the two admin guards
  protect — delete the last grantee, and an ownerless enrolled row becomes
  adoptable with every scope. Scoped to machines the deleted account was actually
  on: a legacy row that was already grantless is left exactly as it was.
- **An admin may no longer take a machine off the person who has it.** `PUT
  /v1/admin/machines/:id/owner` answers `403 machine_owned` for a machine with a
  live owner other than the target, and `403 machine_granted` when adopting an
  ownerless machine somebody already holds a grant on unless they are the one
  being handed it. What it still does is what it was written for: adopting a row
  registered before ownership existed, and re-labelling a machine for the owner it
  already has. Adopting now also burns that machine's outstanding enrollment codes
  — the guard below protects minting, and a code kept from before an adoption
  would otherwise still replace the daemon afterwards.
- **`POST /v1/admin/machines/:id/enrollments` answers `409 machine_enrolled`** for
  a machine that is enrolled and has an owner or grantees. Redeeming a code
  retires the running daemon's tunnel credential, so minting one for somebody
  else's live machine does not read it — it replaces it, and every grant-holder's
  traffic lands in the new process while the owner's list still says owned and
  online. Its owner mints their own. A machine that has never enrolled is
  untouched, which is what the installer's wizard does.
- **Nothing in the rail reorders itself any more.** Rows used to sort by their most
  recent event, and a chat waiting on you jumped to the top of its folder — so the
  list moved under your thumb on every poll. A chat waiting on you still says so
  three ways: the ring on its status dot, its title going semibold, and the count
  on its folder's header. A new session appears at the top of its folder, which is
  now the only thing that moves by itself.
- The back and close controls in every pop-up are bigger — 32px of ink instead of
  24px, with the same 44px target they always had.
- The directory picker writes `~` instead of your home directory in full, and the
  path reads as one string rather than one with wider gaps between some of its
  slashes. The session header cuts the same prefix.
- The `in <folder>` line at the foot of New session is gone. It named the folder
  the picker above it was already showing.
- A row you press down on says so straight away, instead of waiting out the hold
  in silence — holding still is what starts a drag, and nothing on screen was
  saying so. It now lifts under a shadow rather than a change of tone, which is
  the cue a thumb covering the row does not hide, and a phone gives a short
  vibration at the moment the chat comes off the list.
- **The ⋮ menu is drawn on every row in the rail.** It used to appear on hover,
  except on pinned rows, which drew it always — so two rows a few pixels apart,
  alike in every other way, had a different number of controls. A row's only menu
  should not be hidden until you are already pointing at the row.

### Removed

- **`PUT` and `DELETE /v1/admin/grants`, and with them `cpctl admin grant` and
  `cpctl admin ungrant`.** A grant is full access to a machine that runs coding
  agents as its owner, with no sandbox — and these wrote one for *any* machine on
  an admin credential alone, with no consent from the person whose machine it was
  and nothing on any screen afterwards. Sharing is the owner's verb now (below).
  The two `cpctl` verbs answer with the replacement rather than "unknown command",
  because the old spellings are in scripts and in shell history. `GET
  /v1/admin/grants` is kept: seeing who holds what is not the power that was
  removed, and an operator who cannot read that table cannot answer "why can this
  person reach that machine".

- The context-window ring is gone from the web client. It reported how full an
  agent's window was and reported nothing at all on kimi, which never sends the
  notification it was built on, and nothing on any session waiting for its agent —
  a control that was blank for most agents most of the time, in a row where
  everything else changes what the next turn does. Nothing changed on the daemon:
  the reading is still measured, still on every session snapshot, and still
  printed by `pnpm client`.

### Fixed

- **A chat crossing into or out of Pinned jumped.** Making that group a row taller
  pushes the folder below it — and the chat being carried — down by exactly one
  row, which the drag did not know about because it measured from where the row had
  been when the gesture started. It measures from where the row actually is now,
  every frame. The room a group makes also animates on the same clock the rows do,
  instead of appearing in one jump under rows that were still sliding.
- **The last place in Pinned could not be reached.** Aiming at the end of the group
  unpinned the chat instead: "still pinned, at the end" was a band half a row tall
  with unpinning on the other side of it. Carrying a chat out of Pinned now takes a
  deliberate movement past the group, and says **Release to unpin** at the pointer
  while you are out there — it is the one outcome of a drag that dragging back does
  not undo. (Fixed twice: the first attempt widened the boundary only for chats
  already pinned, which left the same slot unreachable for one arriving from a
  folder. The boundary between two groups is now simply whichever is nearer.)
- **`Alt`+`↑`/`↓` on a pinned chat could move a chat on another machine.** The
  keyboard walked every pin in the fleet while the rail draws only the selected
  machine's, so the keypress computed a position among rows that are not on screen
  — usually looking like nothing happened, and occasionally rewriting the positions
  of another machine's pins.
- **Moving a chat down by exactly one place did nothing**, in silence — which is
  why the last slot of a group could not be reached from the row directly above
  it, and why "I still cannot put anything in the last place in Pinned, I can only
  carry the last one higher" was reported after the boundary was fixed. The drop
  compared two positions counted in two different ways, one of them counting the
  chat being dragged and the other not, and treated a genuine one-place move as
  landing where it started.
- **Pinned rode on top of the sessions under it** while a chat was carried into it
  from a folder. Moving rows aside does not make room for one; the group being
  joined now takes the height and the group being left gives it back, so nothing
  past either of them moves.
- **The ⋮ menu on a row stopped opening.** The drag took the pointer at the press
  and the button never heard the click meant for it. The row is the drag surface
  everywhere except where it already carries a control.
- **Dragging on a phone did nothing, through four attempts.** The first two treated
  a cancelled pointer as the gesture ending, which is right for a mouse and wrong
  for a finger: on a touch screen it means the browser has decided the gesture is
  its own, which it does the moment it commits to a scroll. The third moved the
  drag itself onto touch events, which the browser goes on delivering. All three
  left the *setup* — the hold, the listeners, the refusal of the platform's own
  long press — in the pointer press, and that is the assumption none of them
  questioned: that the pointer press arrives before the browser has decided what
  the touch is for. Nothing requires that, and on a browser that decides first,
  every one of those fixes was one event too late, every time. A finger's gesture
  now begins, moves and ends on the touch stream, and the pointer handlers say in
  their own text that they are a mouse's.
- **A drag showed a line instead of moving anything.** The rows now step aside as
  you go, exactly as they do on the agent list, and the drop changes nothing you
  can see — which is what tells you it landed where you left it.
- **Dragging a chat out of Pinned now unpins it** even when the folder it belongs
  to is collapsed or hidden by the filter. It was refused when there was no list on
  screen to drop into.
- **"There is no room between those two rows"** is gone. A drop is never refused
  for arithmetic; the positions around it are re-spaced and the drop happens.
- **A drop at the top of a group sent the chat to the bottom.** Two branches of the
  position arithmetic were the wrong way round, and the test covering them had been
  written from the code rather than from what a drop means, so it agreed.
- **Clicking a chat in the rail with the mouse stopped opening it**, which arrived
  with the mouse drag and had not been noticed. Taking the pointer at the press
  hands every later event to the row's wrapper, the click included, so the button
  inside it that does the opening was never in the click's path. The pointer is
  taken when the drag actually starts instead. Found by driving a real browser
  through the debugging protocol rather than by reading.
- **Dragging a session with the mouse did nothing.** A mouse was being asked to
  long-press, which is a touch idiom: a finger has to be told apart from scrolling
  the list, and a button does not. A press and 4px of movement start the drag now.
- **And on a daemon that had not been restarted it could not have worked, silently.**
  The column that stores the order arrives with the daemon's own migration. Trying
  to drag a row on such a machine now says so. **Restart the daemon once after
  updating.**

- The composer is one box. The message field, the attachment chips, the paperclip,
  the agent's controls and Send now sit inside a single rounded container instead
  of a bordered field, a bordered send button and a separate strip of bordered
  pills below it — seven outlines in two rows at the bottom of a phone. The chips
  lost their borders with it: the box is what says a control is there, and each
  chip's chevron is what says a list opens. A chip that cannot be tapped now dims
  by dropping its ink rather than by fading the whole control, which is a
  correction as much as a restyle — at 40% opacity the border it used to rely on
  was already below the contrast it existed to hold. The rule that used to run
  above the composer is gone; so is the backdrop blur, which was blurring a
  backdrop nothing ever scrolled under.
- Send is a circle with an arrow in it. A paper plane is a mail metaphor for
  something that is not mail, and a filled hard-cornered square is the shape a
  **stop** control has — in the one slot where Stop appears a second after a turn
  starts. All four things that occupy that slot take the circle, so it never
  changes shape under a thumb.
- The mode chip says what it is set to and no longer also says "Mode". The glyph
  beside it, its fixed position and its accessible name already said so, and the
  word was spending width on the narrowest screen next to the value it was pushing
  into a truncation. A chip now draws its own name exactly where no glyph does.
- The controls below the message field rest a shade quieter, and are grouped by
  spacing: a wider gap where the kind of control changes — the paperclip acts on
  the message, the chips describe the turn, Send is the action — and a narrower one
  inside each group.
- Send sits on that row too, level with the attach control and the agent's
  settings, which is what makes the composer read as one object rather than as a
  field with a toolbar under it. On a narrow phone the row is now over its width
  and the chip values truncate, which is what they have always done there under
  pressure; there is no arrangement in which three pills and two icon buttons fit
  a 390px line.
- The empty composer says `Type / for commands` instead of `message…`, because
  `/` is the one thing in the box that nothing on screen advertised and an empty
  box already reads as somewhere to write. It still says just `message…` on a
  session whose agent is away, where that key would open nothing.
- Send is smaller: the same 32px box as the controls beside it, so the row is one
  height end to end and the filled circle is no longer the loudest object in the
  composer. It still reaches the 44px tap minimum, the same way the chips do.
- The picker sheet slides back down when it is dismissed instead of vanishing
  between two frames, its section headings carry the same icon as the chip that
  opened them, and the check beside the chosen row is heavier and now sits on the
  line of the name rather than above it.
- That sheet has two heights and a grab bar that stays put, and it moves with your
  finger rather than after it. It opens at about three fifths of the screen with
  its options not scrolling; dragging it, or dragging the list, takes it exactly as
  far as you drag, and it settles onto whichever height is nearer when you let go —
  full, where the options scroll, or back to where it started. Pulled far enough
  below that, it closes. The bar used to scroll away with the first screenful of a
  long model list and did nothing when you pulled on it, and every control opens to
  full height now, not only the ones with more rows than fit. The sheet also stops
  moving when it arrives: it used to spring back past the height it had settled on
  and wind round to it a second time.
- Less room above the grab bar at the top of that sheet, and a little more between
  a control's icon and the word beside it — at four pixels the two were reading as
  one shape.
- On a phone the agent's settings open as a bottom sheet over a scrim instead of
  as a small panel above the box, and the model control folds into the mode
  picker rather than keeping a chip of its own — so the row is the attach button,
  mode, effort and Send. On a desktop nothing changes: the same panel, in the same
  place, with the model chip still on the row. Both are drawn and the browser
  chooses, so a window dragged across the boundary can never show a picker that is
  not there. The sheet is closed by Escape, by the scrim, or by choosing a row;
  the platform Back button does not close it.
- A chip is as wide as what it says again, capped at 128px and clipped past that,
  and the space inside it between the glyph, the value and the chevron came down
  from six pixels to four. Each chip used to hold open the width of the longest
  value its control could ever show, which is why nothing moved when a value
  changed — and why three chips sat side by side mostly empty. That trade is
  reversed: they hug their content, and a value that grows moves its neighbours
  again.

## [0.7.0] - 2026-09-06

### Changed

- The fleet's `claude` follows the `latest` release channel by default, and the
  channel is a setting: `REEMOAT_AGENT_CHANNEL=stable|latest` in the daemon's env
  file, `--agent-channel` on the one-line installer, `--channel` on
  `deploy/agents.sh`. Both daemon hosts were on `stable` at 2.1.236, a build that
  had never heard of the newest model, while `latest` was 2.1.261. The refresh
  runs `claude install <channel>` rather than `claude update` — `update` follows
  whichever channel the last install wrote into claude's own settings, so a host
  installed on `stable` would have stayed there whatever the env file said. A
  change of channel moves the machine on the next run, down as well as up, with
  the previous build kept on disk and no session interrupted.
- `PUT /v1/me/email` asks an API-key caller with a password for `currentPassword`
  — `400 bad_request` without it, `401 invalid_password` with a wrong one, and
  nothing is written or mailed until it verifies. A session still changes the
  address alone, and an account with no password row is still let through on
  its key. The address is the reset channel; a key can leak from a disk with no
  person anywhere in the chain and no admin reset behind it, where a session is
  a person signed in, listed under Devices and one tap to end.
- `cpctl key` no longer prompts for a password the route never read. `cpctl
  email` still does when the shell holds an API key, and asks nothing when
  `REEMOAT_CP_KEY` came from `cpctl login`, since the route ignores a password
  from a session. `cpctl keys` prints when each key was last used.
- Every two-step confirmation on a settings row is one control, `TwoStep`. The
  first tap still replaces the row's buttons with the question, the act and
  Cancel — Cancel last, on the same pixels, the question standing until the
  server has answered — held in one place and pinned once rather than
  re-derived on each of fourteen sites. The two centred confirmations keep
  their shape; the question reads in the text colour everywhere, with its
  consequence muted under it. Signing an agent out on a machine that has left
  the list is refused, greyed, rather than answered with a toast.
- Settings say less, again: the New session strip's lede, the two limit
  consequences, the not-enrolled line, the agent card's unknown-sign-in line,
  codex's two caveats and the plugin consent's `http` caveat are cut to the caps
  the plan set, with the same facts in fewer words.

### Removed

- An admin's view of anybody else's API keys. `GET` and `DELETE
  /v1/admin/users/:id/keys[/:keyId]` are gone, the fleet list no longer counts a
  person's live keys, and the "API keys" item in a user row's menu — with the
  panel it opened — is gone with them. A key is listed and retired by the
  person holding it, on their own API keys screen or with `cpctl keys`; an
  admin's reach over an account is disable and delete.

### Fixed

- A settings pop-up drew two scrollbars it had no use for on a desktop: a
  horizontal one along its foot and a vertical one down its right edge, on a
  screen that fit. A sheet's body was a padded scroller whose every screen
  cancelled the padding with negative margins, and a scroll container counts
  its own end padding past the content, so each axis had one padding of range
  nothing could show. The body no longer scrolls or pads — every pop-up scrolls
  in a box of its own — and inside the settings and plugins pop-ups the section
  rail and the pane scroll with no bar drawn at all.
- Every row of the API keys table is the same height. A row with a Revoke
  button was the button's height plus padding and a revoked row was its text
  plus the same padding, a third shorter.
- The startup prune deletes only inactive sessions, never below fifty, and says
  what it removed. It read `created_at`, so a conversation older than seven days
  from the day it was *opened* was deleted at the next restart however much it
  was in use — on 2026-09-04 one deploy's restart deleted five of the six
  conversations it had just stopped, with their transcripts (~50 MB), and the
  journal held nothing but `restored 1 session(s)`. A session is now swept only
  when it was ended by a person or by the agent, never started, or given up on
  because the agent no longer holds the conversation (only a manual Resume
  tries again) — never a live one, and never one the daemon ended on its own
  restart or shutdown and is still coming back to, at any age and under any
  cap — and only once untouched for seven days by its last write; a prune
  never leaves fewer than fifty rows (`REEMOAT_MIN_SESSIONS`) — the ones it
  never sweeps first, then pins, then the most recently touched, whatever
  their age; the two-hundred cap is on the rows nobody is coming back to and
  takes the least recently touched of them, pins last; and every id that went
  is printed at startup on its own `store:` line.
- A valid API-key request no longer answers a plain-text 500 when the
  `last_used_at` bookkeeping write meets a busy database: the write is guarded
  the way the session one already was, so a request that could not record its
  own use still succeeds.
- Reset on an Email field survives the next Save. Save sends every SMTP field
  from the draft, and a Reset re-synced the draft only while the form had no
  other edits — so edit Host, Reset From, Save wrote the old From straight back
  under a "Saved." toast.
- Public URL is filled in with the page's own origin on a fresh server, since
  mail cannot be sent without it and the field drew the origin only as a
  placeholder. Save is live at once; the provenance line says "not set" until
  it lands. A value already stored or set in the environment is left alone.
- New key waits for the key list to load rather than opening the leaf during
  the skeleton only to be told the ceiling. A list that failed to load still
  lets you mint.
- Every Revoke on the keys screen and under a user's keys names its key to a
  screen reader.
- Three controls no longer stay live during the write they belong to: a
  field's Reset while a Save is in flight, the strip's Remove while its delete
  is out, and the device-code box, which empties after the code is written so a
  failed send leaves it in the box beside the toast rather than gone.
- The machines list no longer jumps on load: the loading row is the height of
  the machine row it stands in for. And a retired machine leaves the list at
  once rather than a round trip later.
- Revoking the key this browser holds still signs the tab out when browser
  storage is blocked. The one-shot notice for the sign-in screen was written
  unguarded, and a browser with storage disabled threw there before the
  credential was cleared — so the tab kept a dead key and the next request said
  "Your session expired" about an act the person had just chosen.

## [0.6.0] - 2026-09-04

### Added

- `users.password_changed_at` and `api_keys.last_used_at` on the control plane,
  both additive: `GET /v1/me` answers `passwordChangedAt` and both keys routes
  answer `lastUsedAt`, touched on an accepted bearer lookup at most once a minute
  and never on a revoked key. An older client ignores the fields and an older
  control plane answers without them.

- `deploy/ci-freshness.sh`, run weekly by `.github/workflows/freshness.yml`,
  compares each ACP adapter pin in `package.json` with what the npm registry
  serves and writes the answer into the job summary. Being behind is a report
  and never a failure (`FRESHNESS_MAX_BEHIND` is the margin that makes it one);
  a pinned version the registry no longer lists fails the job, since it would
  fail `pnpm install --frozen-lockfile` on the next machine the one-line
  installer sets up; and a registry that could not be asked exits with its own
  code rather than a verdict about the tree. `pnpm deploycheck` drives every
  outcome offline through the `NPM_VIEW` seam.
- `renovate.json`: pull requests proposing dependency bumps, the two ACP
  adapters one each and the rest of the workspace grouped weekly, with exact
  pins and no automerge — a person merges, and each machine still takes the
  change through `deploy/deploy.sh`.
- The daemon keeps the coding-agent CLIs current by itself. `deploy/agents.sh`
  installs what is missing — three with each vendor's own installer into the
  vendors' own directories (`~/.local/bin`, `~/.local/share/claude`, `~/.codex`,
  `~/.opencode`), kimi from the npm registry into `~/.reemoat/toolchain` — and
  refreshes what is there; the one-line installer runs it once, and the daemon
  runs it five minutes after start and then daily. On by default —
  `REEMOAT_AGENT_UPDATES=off` switches it off, and `deploy/agents.sh --check` says
  what a run would do without doing it. `--uninstall` removes the toolchain, and
  the npm-installed CLIs with it, and leaves the vendors' directories in place
  because they hold sign-ins of your own.
- `GET /agents/capabilities` rows carry `cli`: which build of the harness's own
  CLI published the model list, and whether it was an operator's override
  (`override`) or the copy found on PATH (`path`). The model picker draws it under
  the provider heading. Absent from older daemons; `null` where nothing was
  spawned.
- The daemon announces which build of each agent CLI it would launch on the
  tunnel handshake (`x-reemoat-agent-clis`, `claude=2.1.259;codex=0.153.1;kimi=-`),
  beside its own version and under the same rule: recorded against the machine,
  never acted on. `GET /v1/admin/fleet` answers it as `agents` per machine and
  `cpctl admin fleet` prints it, offline machines included — so "which machines
  are running a July claude" is answered without touching one. As fresh as the
  machine's last dial; a daemon older than the header is listed with `null`, and
  a value the relay cannot read is refused to `null` rather than costing the
  tunnel.
- `CLAUDE_CODE_EXECUTABLE` and `CODEX_PATH` are documented in `.env.example`; a
  harness named there runs as named, and the daily refresh leaves it alone.
- `REEMOAT_AGENT_SOURCE=npm`, and the one-line installer's `--agent-source npm`:
  all four CLIs from the npm registry rather than the vendors' own hosts, for a
  machine that cannot reach them. Your mirror is named the way npm is pointed
  anywhere (`~/.npmrc`, `npm_config_registry`); everything lands under
  `~/.reemoat/toolchain`. A choice rather than a fallback — a vendor outage never
  switches a machine to a differently built binary on its own. It decides only
  how a missing CLI is installed: one already on the machine keeps being refreshed
  the way it was installed, and under `npm` a vendor-installed copy is reported on
  every run until it is removed.
- A model id can be **typed** under a routed provider in the agent builder — a
  field at the foot of Moonshot's, Z.ai's, MiniMax's and OpenRouter's rows — for
  an id the written-down list does not hold. It becomes a row like any other, with
  the same key and pairing rules, and picking it names the agent after it. The
  written-down lists are a starting set and were refreshed against each vendor's
  documentation: Moonshot's three had all been retired (`kimi-k3`,
  `kimi-k2.7-code`, `kimi-k2.6` now), Z.ai gains `glm-5.3` and `glm-4.7`, MiniMax
  gains `MiniMax-M3` and `MiniMax-M2.7`. The same mechanism lets an assembled
  agent whose model has since left every list be renamed and saved rather than
  drawing an empty Model field.

### Changed

- Settings is six sections — Account · API keys · Machines, then under an
  "Admin" heading Server · Email · Users. API keys are a table on a screen of
  their own, with when each was made and last used and which one this browser
  holds; New key is one tap, and the key is shown once on `/settings/keys/new`.
  Email (SMTP, the test send, delivery trouble) is split out of Server;
  registration is a badge and a verb button, reminting the provisioning key is
  two-step. Password and email changes are their own screens rather than forms
  opening inside a row — nothing on a settings screen expands in place. Every
  confirmation names its subject with Cancel last; help prose is cut to the caps
  the plan set, and the machine row marks a machine that is not yours with a
  `shared` badge. Revoking the key this browser holds signs the tab out on
  purpose, and the sign-in screen says so.
- `POST /v1/me/keys` and `PUT /v1/me/email` take the session alone: neither asks
  for the current password any more, and a `currentPassword` in the body is
  ignored rather than verified. `POST /v1/me/password` still asks. The cost of
  the email half is written at the route.
- `@agentclientprotocol/claude-agent-acp` 0.63.0 → 0.73.0 and
  `@agentclientprotocol/codex-acp` 1.1.9 → 1.8.0. Re-measured against `claude`
  2.1.259 and `codex` 0.153.1: the model chip reads the model claude's `Default
  (recommended)` stands for rather than the placeholder (the bullet below is the
  rule that makes it so); codex answers `openai` as its provider id where 1.1.9
  answered `custom-gateway`, and nothing had that written down; codex publishes a
  collaboration-mode control and an `ultra` effort level, and claude an `Agent`
  persona control wherever `.claude/agents/` has a file — each drawn as a plain
  labelled control. `node_modules` is 230 MB on darwin-arm64 after the bump.
- The model picker also collapses claude's `Default (recommended)` row onto the
  model it stands for when the placeholder's description is that row's *name*,
  which is what claude-agent-acp 0.73.0 publishes; 0.63.0 copies the row's blurb
  instead, and that case still collapses. Without the second rule the placeholder
  came back after the adapter bump and the chip read "Default (recommended)".
- A session whose harness has no CLI on the machine yet is left waiting rather
  than given up on: the boot pass spends no attempt on it, runs the agent
  installer at once instead of in five minutes, and tries again when it
  completes. The daemon's log shows every completed agent update, with the
  script's own notes under it. Only a missing CLI is treated that way — a missing
  adapter package or a plugin harness that is gone spends its attempts and settles
  as before, since the installer cannot put either back — and only the first run
  is pulled forward; after it the daily run is the retry. The session row says
  "<agent> is not installed on <machine> — waiting for it to be installed" for
  the wait, rather than the plain restart line.
- An empty fleet is set up from the content pane on a wide screen: the one-line
  installer and one line about it draw beside the rail rather than inside it, at
  a width the command can be read at. The command box wraps instead of scrolling
  sideways, on every screen that draws one.
- A machine is added by running the one-line installer on it, and only that way.
  The by-name form on Settings → Machines, which handed back a setup code to
  carry to the host, is gone, and so is the "Add a machine" button that led to
  it; `cpctl enroll` still mints a code for an operator who needs one. Since
  nothing in the tab adds a machine any more, an empty fleet is re-listed on
  every poll, so the machine the script enrols appears by itself.
- Settings say less. Sentences that restated the control beside them, explained
  a mechanism nobody acts on, or printed a URL already on screen were cut
  across Account, Server, Users, Machines, Systems, Agents and Plugins; every
  consequence a person cannot see stays.
- The one-line installer unsets `REEMOAT_API_KEY` as soon as it has read it, so
  the account key no longer reaches `pnpm install`'s lifecycle scripts or the
  vendor installers `deploy/agents.sh` downloads and runs.
- The coding-agent CLIs are no longer installed by `pnpm install`. The two ACP
  adapters stay pinned; the CLI platform packages they used to bring with them are
  excluded through `pnpm-workspace.yaml` overrides, and `node_modules` went from
  907 MB to 217 MB on darwin-arm64 (230 MB after the adapter bump above).
  `deploy/agents.sh` installs the only copies
  there are, and the daemon runs an operator's override, else the first copy on
  PATH, then in the directories that script installs into — re-decided every ten
  minutes, so a refresh under a running daemon is picked up. A harness with no CLI
  on the machine is refused with a sentence naming the script rather than started.
- `deploy/deploy.sh` installs or refreshes the agent CLIs before it restarts the
  daemon, so a machine upgraded from a release that vendored them comes back with
  its harnesses rather than waiting on the daemon's first daily run.
- `--source` and `REEMOAT_AGENT_SOURCE` decide only how a missing CLI is
  installed; one already present is refreshed the way it was installed — a
  vendor-installed copy by the vendor's own updater, an npm-installed one from the
  registry — and the one thing a switch to `npm` cannot refresh, a vendor-installed
  copy, is named on every run until it is removed.
- The one-line installer refuses `--agent-source` on a machine that is already
  set up, naming `REEMOAT_AGENT_SOURCE` in the env file rather than accepting a
  flag that would change nothing.
- The one-line installer's questions are arrow-key menus, and a password or API
  key no longer reaches `curl`'s command line.
- `controlPlaneUrl` on `POST /v1/machines`, `POST /v1/machines/:id/enrollments`,
  `POST /v1/provision` and the admin mint honours `x-forwarded-proto` behind
  `REEMOAT_CP_TRUSTED_PROXY_HOPS`, so a daemon enrolled through a TLS proxy dials
  `https://` rather than the plaintext origin.
- `--uninstall` exits non-zero and leaves the private node in place when the
  service could not be stopped, rather than deleting the node a still-installed
  unit runs. `--purge` always confirms and names the database and checkout it is
  about to delete, not only the worktrees; `--yes` still answers.

## [0.5.0] - 2026-09-01

### Added

- **One command puts a machine in the app.** `curl -fsSL <release asset> | sh`
  installs the daemon, asks which control plane to join and who you are on it —
  sign in, sign up, or paste a key — creates the machine and starts the service.
  No `sudo`, nothing written to a shell profile, and nothing outside `~/.reemoat`
  and the checkout, which is what makes `--uninstall` complete rather than
  approximate. It hands the last third to `deploy/install.sh daemon
  --non-interactive` rather than reimplementing unit rendering, PATH computation
  and the health probe.

  **Where the software comes from and which fleet it joins are two questions,
  and the command keeps them apart.** The README downloads from a release asset
  on this repository; a control plane serves the same file at `GET /install.sh`
  with its own origin substituted in, which is what Settings → Machines prints
  and why there is nothing to type there; `--url` or `REEMOAT_CONTROL_PLANE`
  says it outright. Fetched from anywhere neutral it **asks**, with no default —
  letting a download URL also decide which fleet a machine joins is how somebody
  who wanted their own control plane arrives in one they do not run.

  Three things about it are load-bearing rather than tidy. Everything runs from
  one `main "$@"` on the last line, because `curl … | sh` executes bytes as they
  arrive and a truncated download otherwise runs a *prefix* of the file with
  `set -e` silent. Every question is asked on `/dev/tty`, because stdin is the
  download. And the origin substituted into the served copy is shell-quoted: a
  `Host` of ``a`id`b`` reaches `URL.origin` intact, and `imagecheck` sends one
  through a real container to prove the quoting is on the path a request takes.

- **A host can pull the control-plane image instead of building it.**
  `REEMOAT_CP_IMAGE` decides — a registry-qualified ref pulls, a bare one builds
  — and `deploy.sh` prints which on every run. `REEMOAT_CP_SOURCE` overrides the
  derivation, and an unrecognised value is refused rather than defaulted.

  In pull mode `CP_IMAGE_INPUTS` does not apply: a git diff is a guess at what a
  build would produce, and a registry ref names exact bytes. Everything
  downstream is untouched — `cp_image_fingerprint` inspects the local image
  either way, so `CP_IMAGE_MOVED` and the `RELAY_INPUTS` rule that decides
  whether the fleet's tunnels drop behave exactly as they do after a build.

### Fixed

- **The documented way to run the published image had never worked.**
  `deploy/README.md` said to put `REEMOAT_CP_IMAGE=ghcr.io/…` in the control
  plane's env file. It could not win: compose gives the shell environment
  precedence over `--env-file` for `${…}` interpolation, and `compose.sh`
  exported its own default before compose ever ran — measured, `compose.sh
  config` with a registry ref in that file still printed
  `image: reemoat/control-plane:current`.

  The half with no symptom is worse. `deploy.sh` calls `cp_image_fingerprint`
  from a process where that variable may be unset while compose's child had it
  from the file, so the fingerprint would inspect a *different name*, answer
  empty on both sides, conclude the image had not moved, and recreate nothing —
  a deploy that printed success while the old bytes kept serving. There is one
  resolver now (`cp_image_ref`), every script reads it, and `deploycheck`
  asserts no script holds a second copy of the default.

- **`GET /install.sh` answers with the scheme a browser actually used.**
  `publicUrl` takes it from `socket.encrypted`, and the service runs plain HTTP
  behind a proxy that terminates TLS — so it answered `http://`, and the plain
  form of a deployed origin is a `301` the installer deliberately does not
  follow. `x-forwarded-proto` is read, gated on `trustedProxyHops` exactly as
  `callerAddressOf` is. ⚠ The same defect on `controlPlaneUrl` (four
  code-minting routes) is known and **not** fixed here: changing `publicUrl`
  itself changes what every enrollment paste has said since the first release.

## [0.4.0] - 2026-09-01

### Fixed

- **A pasted key no longer expires on its own, and a machine left alone over a
  holiday comes back signed in.** There was a sweep in `prune()` that deleted a
  saved agent credential once it was older than the session horizon *and* no
  sessions were left. Both halves had to be true, which read like a narrow rule and
  was not: `updated_at` moves only when a key is **pasted** — nothing touches it on
  read — so the age half was permanently true of every key in real use, and what
  was actually left binding was "no sessions left", which unpinned sessions reach
  after seven days. Eight idle days and a restart, and the paste was gone, with
  nothing on any screen connecting the two. It is removed: a key in
  `agent_credentials` or `system_credentials` now goes when you clear it, when a
  paste replaces it, or when you uninstall the plugin that added the harness or
  provider it belongs to — and at no other time.

  ⚠ **A daemon that ran an earlier build may already have deleted keys this way,
  and there is nothing to restore** — the sweep was a plain `DELETE`. If a machine
  that has been quiet for over a week now reports an agent as signed out, that is
  this bug rather than anything at the vendor: paste the key again under Settings →
  Machines → this machine, and it will stay. Deleting a local copy never revoked
  anything at the vendor, which is the largest reason the sweep was not worth its
  cost. `docs/DECISIONS.md` Q7.124 carries the whole argument.

- **A harness that will not start stops being offered, and stops costing a
  worktree.** Reported with a screenshot: New session drew a tile for an agent a
  plugin had added, Start answered *"rejected session/new: authentication
  required"*, and the tile was still there for the next press — and the one after
  that. The daemon remembers a refused start now, so the tile goes, the model
  picker greys the row, and a second press is refused before a worktree, a branch
  and a session row are made for it. It is remembered for ten minutes rather than
  written down: an agent's refusal is an observation, and this project has once
  already turned one into a standing verdict and stranded conversations under it.
  A successful start forgets it, so does pasting a key, so does finishing a sign-in
  in the app, so does switching the plugin off and on — and where none of those
  happened there is **Check again**, on the machine's agent list and on the agent's
  own card, for after you have signed in on the machine itself.
  `pnpm client agents recheck <agent>` is the same thing from a terminal.

- **A settings card called an agent a plugin added by its identifier.** Every
  sentence on that card named the harness with this product's own table, which
  answers the bare id for anything it does not ship — so the card read *"byo:gemini
  needs no sign-in"*. It uses the manifest's name now, bounded, exactly as the
  tiles and the refusal sentences already did.

- **A resumed session no longer reports a demotion that did not happen.** An agent
  that comes back on the model it was started with, and has since stopped *listing*
  that model, drew an error row contradicting itself in one sentence — *"has no
  model called X … resumed anyway, running X"* — because the pin asked whether the
  model was **offered** rather than whether the session was **on** it. Worse, the
  same refusal made `POST /sessions` answer a permanent `502` for a preset whose
  model the agent was running. Both gone: the pin answers "already there" before it
  reads the list.

### Changed

- **Settings → Machines → *Systems* is now *Sign-ins*, and it holds both halves.**
  Signing in on a machine was never only about inference: a harness can read a key
  of its own, and until now the only place that key could be typed was a
  *provider's* card — reached when that provider named the harness. Every harness
  this product ships is named that way, so all four had one; a harness a plugin
  added had one only if that plugin also contributed a provider naming it, and
  nothing required that. A key box could be declared in a manifest and drawn on no
  screen at all. Such a harness has a row of its own now, after the providers,
  saying whether a key is saved. Nothing changes on a machine with no plugins —
  adding every harness would have put Claude Code beside Anthropic, which is two
  rows for one account.

### Added

- **A plugin can add a harness, or a provider.** Two declarative blocks in
  `plugin.json` — `contributes.harnesses` and `contributes.systems` — put an ACP
  program and an inference endpoint on a machine, and both then behave as though
  this product had shipped them: the harness is in the agent builder's harness row
  and in Settings → Machines with a paste box, and the provider is a heading in the
  model picker and a key box beside the built-in ones. The two are assembled into a
  named agent exactly as Claude Code on OpenRouter is, and **that** is what gets a
  tile on New session — a plugin adds a harness, never an agent, because whether a
  harness is a whole answer on its own is a claim about the *model* that nothing on
  the machine can check. No plugin code runs for either and nothing is fetched at
  runtime; the daemon reads the manifest and answers its own routes with it.

  A machine that has just been told about a harness asks it whether it starts,
  rather than leaving that to whoever presses Start first: installing, updating or
  switching a plugin on runs the same capability read the agent builder does, so
  the answer is on screen before anybody taps anything.

  Both need plugin API 5, and a daemon that speaks less refuses the block rather
  than ignoring it — a plugin whose whole reason to exist is a harness has no useful
  degraded form, so its owner is told to update the machine instead of installing
  something inert. Two new scopes say what is at stake, and the consent screen also
  draws the **command line** and the **whole base URL**, because a line in a list is
  where somebody learns a capability exists and not where they can judge one. What
  is drawn is exactly what the daemon compares, so a commit asking for more than was
  shown is refused before the plugin runs — including from a browser too old to have
  drawn the rows at all.

  A provider's endpoint may be `https` anywhere, or `http` to this machine or this
  network, which is what makes Ollama, vLLM and LM Studio reachable; where it is
  `http` the consent screen says the key travels in the clear.
  `rends-east/reemoat-plugin-byo` is a working example — Gemini CLI as the agent,
  DeepSeek as the provider, both measured — and it holds no scope that gates a
  method, so its consent card shows the two things it adds and nothing else. A
  contributed harness
  has no sign-in wizard and will not get one — everything a wizard needs is a
  measurement about somebody else's CLI — so it is opencode's shape: a paste box and
  nothing else. Uninstalling a plugin now takes its saved keys with it, out of both
  credential tables; switching one off keeps every session, preset and position it
  had, and putting it back brings them all back.

- **The agent row on New session is yours to arrange.** The gear at the end of it
  opens a per-machine **Agents** screen — reachable from the machine's own settings
  too — where every agent that row can offer is a full-width row you can drag,
  hide, edit and remove, with the `+` that used to sit in the strip now at the foot
  of the list it adds to.

  The order and the hidden set live **on the daemon, per machine**, so they are the
  same from a phone and a laptop and survive the reload a phone performs on its
  own. What is stored is a *partial* record — a position for what somebody actually
  moved — merged over whatever the machine currently reports: an agent it has never
  heard of appends at the end and is visible, and an agent that is signed out or
  gone keeps its place for when it comes back rather than losing it.

  Every row is draggable **and** movable from the keyboard, with `↑`/`↓`/`Home`/`End`
  on the handle — a 44px target that keeps the sheet from scrolling under a thumb.
  Everything a row can do is behind one menu, on every row, and **every** row can be
  edited and removed: a built-in agent and one you assembled are the same thing from
  the picker's side — the built-in one is just the one that is there by default.
  Editing it opens the builder already pointed at that harness. Removing signs nothing out. A built-in row stays where it is,
  dimmed, offering to add it back; an assembled one is deleted and rebuilt from *Add
  an agent*, and sessions started on it keep resuming on the bare harness. There is
  no confirmation, because neither is a thing you cannot redo.

  Opened from the gear, the screen's ◀ goes back to the New session sheet you left —
  folder walked and agent chosen — rather than further into settings.

  A machine whose agents are *all* hidden says so, and points at the gear.

  **The first agent in that order is the one a new session opens on, and its row
  says `default`.** Drag another to the top and it becomes the default. "First"
  skips a row that cannot be started — a hidden one, a harness that is signed out,
  an agent assembled on a harness that has since been uninstalled — because those
  have rows here on purpose and none of them is what a new session can open on. It
  also fixes the picker: the last of those three used to be selected on arrival and
  then refused, leaving New session with no agent chosen and **Start** dead until
  you tapped one.

- **A built-in agent's tile says which system it runs on.** Claude Code ·
  Anthropic, Codex · OpenAI, Kimi Code · Moonshot — on the New session tiles and on
  the rows of the Agents screen. It used to say `signed in`, which is true of every
  agent you can actually start and therefore says nothing; a status only appears
  now when there is one worth reporting, and it displaces the vendor.

- **The agent row says when it is cut off.** A gradient at its right edge, on
  exactly while there is more to the right of it — the same fade the transcript
  draws under a session's name. The scrollbar under the row reports where you are;
  this is the part that says there is somewhere to go before you have touched
  anything.

- **opencode is a fourth agent, and it needs no signing in.** `opencode acp`,
  vendored and pinned like the other adapters, and it needs no new machinery
  either: it publishes a model control under `category: "model"` and answers
  `session/set_config_option`, which is exactly the call an assembled agent was
  already pinned with.

  Measured: with nothing configured at all it runs on **OpenCode Zen's free
  models**. So there is no sign-in wizard, no sign-out button, and no status under
  it either — an agent with nothing to report shows nothing, rather than a
  `cannot check` that reads as a fault. The settings card still carries one
  sentence saying nothing is missing and what a key buys.

  It has **no tile of its own** on the new-session screen, and that is the same
  fact from the other side: the other three harnesses *are* the model they run,
  and this one is a router. Started bare it picks `opencode/big-pickle` off that
  free tier — a model nobody chose, under a tile that names none — and a saved
  OpenRouter key widens its catalogue to 362 without moving that default one row.
  It is a harness everywhere else: build an agent with it, pick a model, and it
  behaves like any other.

- **Assembling an agent refuses a pairing before you can make one.** Choosing a
  harness first now collapses every provider it cannot be pointed at to a single
  greyed line in the model list — so `opencode` no longer offers Claude's models
  and then refuses to save. Each of the two fields has a `Clear` beside it, and
  the reason a pair is refused is drawn on the row it is about rather than only at
  the foot of the sheet.

- **OpenCode Zen is a provider in its own right**, beside OpenRouter — both
  reached by opencode, which publishes them in one list that the picker now
  divides by provider. Its free models are the six you get with no key; an
  `OPENCODE_API_KEY` opens the rest, 93 in all. Rows are named as the provider
  names them — the `OpenCode Zen/` the CLI puts on the front is dropped, since the
  heading over the row already says it.

- **OpenRouter is a sixth provider, with its whole catalogue in the picker.**
  Reached two ways at once, like Moonshot: opencode runs it natively, and Claude
  Code can be pointed at it. The catalogue is read **by the browser** from
  OpenRouter's own host rather than written down here or proxied by the daemon —
  289 models under one heading. Two things are left out and for one reason —
  each would only fail confusingly at somebody else's endpoint: a model that
  cannot call tools, and the `:batch` rows, which are the pricing tier of an
  asynchronous API with a 24-hour completion window that nothing here can submit
  to or poll. A model both opencode and the catalogue name is one row, runnable by
  either harness.

  ⚠ **If you serve the UI yourself, `connect-src` now has to name
  `https://openrouter.ai`.** Without it the picker's OpenRouter section never
  fills. See `packages/control-plane/.env.example`.

### Changed

- **The model picker puts the providers you can actually use first.** Any provider
  this machine can start a model on floats above every provider it cannot — so the
  ones whose rows would read *"No … key on this machine."* sink to the bottom
  instead of sitting between you and the one you use. "Can use" is the same test
  that greys the rows, so the order and the greying always agree: a provider whose
  models are published by a signed-in harness counts, even with no key of its own
  pasted anywhere.

  Under that, the default order changed too: Anthropic, OpenAI, **OpenRouter**,
  Moonshot, Z.ai, MiniMax, OpenCode Zen. OpenRouter is the widest catalogue and the
  commonest reason to scroll at all, and it used to sit below one vendor's four
  models. Zen is last by default and floats like anything else on a machine that
  holds its key.

- **The `+` at the end of the agent row is a gear, and the `Edit <agent>` line
  under the row is gone.** Both acts moved onto the Agents screen the gear opens,
  where an agent is a row with room for its own controls rather than a 112px tile
  in a strip you drag sideways. Nothing below the picker appears and disappears as
  you tap along the row any more.

### Fixed

- **`touch-action: none` did nothing, on every button in the app.** `index.css`
  declared the `touch-action` default for `button` outside any cascade layer, and an
  unlayered rule beats every Tailwind utility regardless of specificity — so the
  `touch-none` class was dead wherever it was used. The visible cost was that the
  agent list could not be dragged on a phone at all: the browser took the gesture
  for the scroller before the first `pointermove`. A mouse is not gated by
  `touch-action`, which is why it only showed up on a touchscreen.

- **A fourth harness would have drawn a blank tile.** `AgentGlyph`'s comment had
  claimed for four releases that a missing arm was a compile error; it was not —
  the function answers `ReactNode` and `undefined` inhabits it, so a `switch`
  falling off the end returned exactly that. It ends in a `never` arm now, and a
  missing glyph really is a compile error.
- **The composer strip said three different things about a fourth agent.** The
  mode control read `Session Mode` where the other three read `Mode`; its modes
  read `build` and `plan` where the others read `Plan Mode` and `YOLO`; and the
  effort control was simply not there. `labelFor` reconciles the first, a new
  `choiceLabel` — the one place a choice is named, capitalising a mode's first
  letter and nothing else — reconciles the second, and `drawnControls` now keeps
  the effort slot even for an agent that never published one, so it opens and says
  the model offers no levels rather than being absent.
- **A control the agent published with nothing to choose from** drew as a working
  chip that opened onto an empty panel. It is drawn as unavailable now, like one
  that was withdrawn.
- **A turn that ended in an error never said it had ended.** Four prompts, three
  `turn_end`s, in a log anybody could read: a rejected `session/prompt` became an
  `error` event and the turn was simply over. The daemon writes the end now, with
  a stop reason of its own (`agent_error`) because none of ACP's five means
  "failed". Nothing was stuck — what was broken is quieter: a turn that failed
  mid-delegation left "waiting for 1 task" under the transcript for the rest of
  the session, the `turn.ended` plugin hook never fired, and the turn's origin
  claim was never spent, so a plugin that started it had the *next* turn's hook
  suppressed instead. Nothing new is drawn: the agent's own error is already the
  row above it.
- **The assemble-an-agent screen was a spinner for five seconds.** It waited for
  `GET /agents/capabilities`, which starts an agent per harness — measured at
  5286 ms cold — although only the model list needs the answer. The screen now
  draws as soon as the cheap table read lands and one row says what it is waiting
  for; nothing on it can claim a pairing is possible, or refused, before the
  answer arrives.

  The read itself went from **5286 ms to 2159 ms**, in two steps. It asks every
  harness at once rather than one at a time — the daemon's concurrency bound is
  untouched, because the cap now queues instead of refusing, and a plugin's own
  model request is still refused rather than parked. And it no longer holds the
  answer while it tears the agent down: codex's model list is ready at 383 ms and
  its teardown took 2011 ms more, because it does not answer `session/close` and
  the close waits its full budget. The daemon still cleans up, and still counts the
  process against its own limit while it does — the caller just stopped waiting
  for it.
- **The agent builder asked the slow question first.** Its two rows are Harness
  and Model, and only the model list waits on the machine — the read that starts an
  agent per harness to find out what each can run. It was on top, so the first
  thing on the screen was a row saying *Reading models…* that could not be opened,
  above a row that was ready immediately. They are swapped: choose the harness,
  which costs nothing, and the catalogue lands while you do. It is also the order
  the model list is built for — with a harness chosen, every provider it cannot be
  pointed at collapses to one greyed line, so a refusal now arrives before the
  choice it is about rather than after it. Neither field is required first and
  either can still be cleared.
- **A model that cannot call a tool was offered as an agent.** The catalogue
  filter that drops those had only ever been applied to the list this browser
  fetches — and opencode publishes its own copy of OpenRouter's, unfiltered, image
  models and all, which got merged straight past it. Assembling one produced a
  session that failed on its first turn with OpenRouter's own accurate sentence.
  A refusal the catalogue has already made now outranks whatever the harness
  lists, and a catalogue that could not be read refuses nothing.
- **The agent strip is a row you can actually move, and the `+` is in it.** The
  layout always scrolled; a mouse simply has no gesture for a horizontal box, and
  this strip hid the one bar that says so. A wheel scrolls it now, handing the
  gesture back to the page at either end. The `+` is the row's last item — an
  ordinary one you scroll to, not a button pinned to the right edge in front of the
  last tile.

  The bar under it is the app's own, not the browser's: it appears with the first
  notch and fades a second after you stop, the way an overlay bar does. It had to
  be drawn by hand, because a real scrollbar in this app cannot be animated at all
  — Chrome ignores every `::-webkit-scrollbar` rule on an element that sets
  `scrollbar-width`, which this app sets on everything, and what is left switches
  between two frames.
- **The new-session picker offers the agents you can start, and nothing else.**
  A harness that is not installed, or is installed and signed out, had a tile of
  its own explaining why — so a machine with one working agent showed three tiles,
  two of which were labels. Those are gone, and with them the `signed in` line
  under the ones that remain: it was a fact true of every tile in the row. An agent
  that cannot say whether it is signed in still has a tile, because that is kimi's
  permanent answer and a probe that timed out is not a sign-out. Signing in is
  still on this screen — on a machine with nothing to start, it is what the screen
  offers instead of an empty row — and the settings card is unchanged.
- **A session pinned to one provider was offered another one's models.** opencode
  publishes one model control holding both its catalogues, so an OpenRouter
  session's own picker carried six OpenCode Zen rows — and choosing one left the
  session running a model its preset does not name, with nothing on screen saying
  so. The snapshot's model list is now the session's own system's; the transcript
  still records everything the agent published, and the model the session is
  actually on is never filtered out of its own picker.
- **opencode's model names were mostly the provider's.** It publishes one model
  control holding 356 `OpenRouter/…` rows and six `OpenCode Zen/…`, so the chip —
  which has room for about eleven characters — spent all of them saying
  `OpenRouter…` instead of which model. A word every row repeats is taken out of
  every row, in the chip, in its menu and in the `/model` list, and the values sent
  to the agent are untouched. No heading replaces it: with a session's list now
  narrowed to the provider it actually routes through, a heading would sit over
  every row and tell you nothing. Where a control really does hold two providers
  nothing is shortened at all, so no two rows can be read for each other. The
  tooltip over a truncated chip said "Model"; it says the model.

## [0.3.0] - 2026-08-22

### Added

- **Sign in with your username or your confirmed email address.** One field, one
  answer to every refusal, and the address is accepted only once it has been
  confirmed — an unconfirmed claim can be written by anyone from the anonymous
  sign-up route, so it reserves nothing and opens nothing. The name is resolved
  first, which settles the one ambiguous case (a legacy name holding an `@`) without
  a new error code an unauthenticated caller could read as an existence oracle. One
  account named two ways spends two guessing counters, deliberately: folding them
  would key the counter on the account, which is the lockout weapon the throttle was
  built to remove.

- **Plugins.** A machine can be given a plugin: a `.tar.gz` holding a manifest and
  a file of JavaScript, installed by whoever owns that machine. A plugin can draw
  a screen, draw its own settings pane, put an action on a session's menu, and run
  code when a session starts, a turn ends, a session ends or an agent asks a
  question. It reads sessions, transcripts, diffs and workspace files, creates and
  prompts and stops sessions, keeps its own data, and reaches host names it
  declared — each behind a scope it names in its manifest and that is shown to
  whoever installs it. `docs/PLUGINS.md` is the author's guide and
  `plugins/board/` is a working one.
- **`pnpm client plugins`, and `plugin install | remove | enable | disable | view`.**
  Installing an id that is already there updates it, and what the plugin stored
  survives that — if the new version will not start, the old one keeps running and
  nothing on disk changes. That holds for a reinstall of the version already
  installed, and for a plugin that is switched off: the build is started long
  enough to prove it runs and stopped again before the row is written, so an
  update nobody could have noticed was broken is refused rather than committed. Seven new daemon routes under `/plugins`.
- **Plugins on the machine's settings screen**, beside its agents, with each
  plugin's scopes written out as sentences on its row. A plugin that draws a
  screen gets a launcher in the rail's footer and a route of its own at
  `/p/:machineId/:pluginId`.
- **A plugin's row can go somewhere, and a screen can keep up.** A row names a
  session on the machine or the plugin's own screen — a destination this app has,
  never a URL — and tapping it opens that. A view can ask to be re-read on an
  interval, floored at two seconds and spent only while somebody is looking; the
  old view stays until the new one arrives, and a failed tick says nothing.
- **A row can say what it means** — `ok`, `warn`, `danger` — and the app picks the
  ink. This is the answer to "let a plugin send CSS", which it may not: naming
  meaning survives a refactor and cannot put a value below the contrast floor.
- **`permission.resolved`, `sessions.answerElicitation` and `agents.list`**, each
  closing an asymmetry: a plugin could learn a question was asked and not how it
  ended, could answer a permission but not a form, and could start a session
  without being able to ask which agents this machine has.
- **A plugin market**, read by the browser and never by the daemon. The catalogue
  is its own service on its own host, named by `REEMOAT_CP_PLUGIN_CATALOGUE_URL`
  and reported to the client as `plugins.catalogue` on `GET /v1/instance`; an
  instance that sets none has no market and says so. Installing from it is
  `POST /plugins/source`, which hands the daemon a repository and a **commit**
  rather than an archive, so what arrives is what the catalogue pinned. The daemon
  still discovers nothing and polls nothing.
- Plugin API **4**, in three rungs that all land here. The floor stays at 1, so a
  plugin written for 1 runs untouched; one that needs more declares the rung it
  needs and is refused by an older daemon with a sentence rather than losing its
  navigation quietly. **v2** added `open`, `refreshMs` and `tone`; **v3** added the
  `model` scope; **v4** added `model.list` and the optional `model` on
  `model.complete`. Declaring `2` and using the `model` scope is refused, so the
  rung to declare is the highest one whose features a plugin actually uses.

### Fixed

- **Nothing an agent asks you is shortened any more.** The daemon clipped a
  question's prose at 512, 100 and 300 characters and a permission's title and
  option names at 200; the browser deleted an answer whose label would not fit a
  button, and clipped the collapsed question bar with CSS. All of it is gone. What
  bounds a form now is one 32 KiB refusal over the whole thing, and what bounds a
  permission is one 8 KiB refusal over its title and options together — a card that
  large is declined *to the agent*, which is a sentence it can act on, rather than
  delivered silently shortened. Measured on a real log, one option description was
  318 characters against a 300 cap, and five of fifteen option labels were over the
  button ceiling.
- **An answer the agent offered is never removed to make the buttons fit.** Past the
  label ceiling the card lays its options out as full-width rows instead — the same
  arrangement it already uses for a question — keeping the refusal first and the
  reversible approval filled. This mattered most where it was least visible: when a
  question arrives down the permission channel and cannot be classified, the options
  are the model's own written answers, and two of four were being deleted with
  nothing said.
- **A question you have already answered still says what was asked.** The transcript
  showed the adapter's preamble — "Please answer the following questions." — over the
  values you picked, because the questions themselves live in the tool call's
  arguments and nothing was reading them. Each question is now drawn over its own
  answer, matched by the words you tapped rather than by any adapter's field naming.
- **Menu rows line their text up with their icons.** Seven rows across the account
  menu, the chat filter, the settings kebab and the plugin menu asked to be centred
  and none of them was: Tailwind emits its utilities alphabetically, so the shared
  row's `items-start` outranked every `items-center` a call site appended, whichever
  order they were written in. The shared string states no alignment now — the caller
  does — and a check sweeps every call site for the same class of silent override.

- **A plugin's lifecycle now knows which child it is talking about.** Every launch
  carries a generation and every late callback is gated on its own, which closes
  three separate defects that shared one cause: a dead child's exit could null the
  reference to its live replacement and leave an unreachable process behind; a
  child's call ids restart at 1 each launch, so a slow `net.fetch` from a crashed
  plugin could resolve a *different* call in its replacement with the wrong data;
  and timers left over from a crash could stop the healthy child that replaced it.
- **`plugin install` and `plugin remove` no longer leave a child nobody holds.**
  A stop cancels a scheduled restart on every call rather than only when it does
  real work, and a stop that supersedes one still in flight waits for both — so
  `shutdown` no longer returns while a process is still being killed.
- **A refusal from the auth or scope check on a streaming route releases the
  request body.** The three routes that stream their own bodies cancel them on
  every refusal *they* make, but the middlewares above them answered without
  releasing anything, and an unread body parks the sender against the relay's
  window. The obligation now hangs off the same guard that grants the exemption,
  so a fourth streaming route gets both halves by adding one string.
- **The plugin data quota counts bytes.** It counted UTF-16 units on one side and
  SQLite characters on the other, so ten emoji were charged 12 or 22 against the
  42 they actually occupy — roughly three times the ceiling was reachable.
- **An oversized message no longer looks like a hang.** Anything past the 256 KiB
  IPC bound was dropped in silence and charged to the plugin as a timeout, so three
  large form submissions from a `session:write` caller would stop a plugin that had
  done nothing wrong. It now fails at once and says what happened.
- `ctx.agents.list()` and `ctx.sessions.answerElicitation()` are reachable from a
  plugin, and `ctx.files.list` — which never had a host method — is gone.
- **`ctx.store.entries(prefix)`**, a paged batched read, because the reference
  plugin's own screen was a thousand round trips per redraw with no other option.

### Security

- **Nothing is sent until you have read what the plugin asks for.** Choosing a file
  no longer uploads it: the manifest is read where you are — in the browser, and by
  `pnpm client plugin install` at a terminal — and its scopes, the hosts it named and
  the events it asks to be told about are drawn before anything crosses the network.
  This is what `SECURITY.md` meant by "named before somebody consents to it", which
  until now was not true: the archive was unpacked, the row written and the plugin
  started, and the scopes appeared afterwards on the row of something already
  running. Neither reader validates — the machine still refuses authoritatively —
  and an archive that cannot be read says so rather than guessing, with a separate
  named press as the way past.
- **A plugin runs as you, and the browser runs none of it.** A plugin is a child
  process of the daemon with your uid and your files — the same trade an agent
  already makes on the same machine. Its declared scopes are hygiene rather than a
  fence, and `SECURITY.md` says so in those words. What is a real boundary: a
  plugin returns a *description* of a screen and the app draws it, so the origin
  holding your credential executes nothing a plugin author wrote. There is no
  registry, nothing downloads a plugin, and nothing updates one by itself.

## [0.2.0] - 2026-08-21

### Added

- **Signing out is a state of the machine.** A credential is read once, at spawn,
  so an agent started while signed in kept answering for an account somebody had
  just revoked. Signing out now ends every conversation on that agent
  (`agent_signed_out`), a prompt is refused before it can reach a signed-out agent
  — a sign-out done in a terminal, or an OAuth session that simply expired, is
  reported by the agent itself (`errorKind: authentication_failed`) and ends the
  conversation the same way — and signing back in resumes **exactly** the sessions the sign-out
  ended, leaving hand-stopped ones alone. Refused only on a CLI's explicit
  "signed out". There is deliberately no probe on the prompt path: one there cost
  a spawn per message and made the offline drivers depend on whether the person
  running them was signed in. Q7.100.
- **A signed-out agent says so in the conversation, with a Sign in button** that
  goes to that machine's own agent screen — instead of a toast, which carried the
  one refusal on this screen with a real remedy in the place that has no room for
  one. The session is ended rather than merely refused, so "signed out" is a
  single state; the draft is still restored, and signing in brings the
  conversation back with it waiting. Q7.102.

### Fixed

- **Settings stopped flickering on every tab switch.** A wake deliberately forgets
  each machine's route, and the re-probe published `probing` for a machine already
  known to be online — so machine dots blinked and the agents panel *unmounted and
  remounted*, restarting its fetch and discarding anything half-typed into a
  credential box. A re-probe now keeps the answer it already has. Q7.101.

- **Import my code** — `POST /fs/import` takes a `.zip` or `.tar.gz` and unpacks it
  into one new folder inside the directory the new-session picker is standing in,
  then moves the picker into it. The archive comes from a Claude Code skill the web
  UI hands over as a single paste, run in a session on the machine the code actually
  lives on, so the code and the context around it are collected by an agent rather
  than guessed at by a glob. Format is decided by magic bytes, never by filename.
  `.claude/rules/code-import.md` is the whole argument; Q2.107–Q2.110 are the
  measurements.
  - **Containment is rebuilt from scratch for archive members**, because every
    member path is a string a remote party wrote. `safeMemberPath` is pure and
    refuses first — absolute paths, any `..` segment (refused, never normalised),
    backslashes, control characters, symlinks, hardlinks, devices and `.git` — and
    both readers go through it so the two formats cannot disagree. Every write is
    `O_EXCL`.
  - **Nothing in the target is touched until one `rename`**, so a failed import
    leaves the folder exactly as it was. A destination that already exists is
    refused rather than replaced, `rename` onto an empty directory included.
  - Bounds: 50 MiB on the wire, 500 MiB unpacked (charged against bytes actually
    produced, not declared), 20 000 members, one import at a time per daemon.
- **A read-only grant is now asserted to be read-only on a mutating route.**
  `daemoncheck` grew `tokenWith`, and the scope refusal it exercises had no
  assertion anywhere before.

### Changed

- The 1 MiB request-body bound now exempts routes through one named predicate
  (`isStreamingRoute`) rather than an inline regex, since there are two of them.


## [0.1.0] - 2026-08-18

First public release. The repository was published with fresh history as a single
commit, so there is nothing before this and no diff to link.

### Added

- **A protocol version *range* on the relay tunnel**, so a bump is no longer a flag
  day. `RELAY_PROTOCOL_MIN_VERSION`/`RELAY_PROTOCOL_VERSION` bound what a relay
  speaks and `negotiateProtocolVersion` takes the newest both ends know: a daemon
  ahead of the relay is negotiated **down** rather than refused, one behind keeps
  working until the floor is deliberately raised. The relay answers the agreed
  number on the 101 as `x-reemoat-relay-agreed`, and every stream down that tunnel
  carries it — not the relay's own maximum. `.claude/rules/compatibility.md` is the
  order to make a breaking change in.
- **`x-reemoat-daemon-version` on the tunnel handshake**, and `src/version.ts`'s
  `DAEMON_VERSION` behind it. Advisory: recorded, reported, and branched on by
  nothing. The relay stores it against the machine on dial.
- **`GET /v1/admin/fleet`** and `cpctl admin fleet` — what every machine last
  dialled in as, **offline ones included**, because the machine that decides
  whether the floor can move is the one that has been dark for a month.
- **`version` and `protocol` on the daemon's `GET /health`**, unauthenticated like
  the clock beside them: a client that cannot get a token yet is the one that most
  needs to know whether the daemon it is pointed at is older than it is.
- **A `migrate()` for the control plane's SQLite**, additions only, with
  `CP_SCHEMA_VERSION` deliberately not moving for one — so yesterday's image still
  starts against today's database and a rollback stays a rollback. `deploycheck`
  asserts that shape rather than trusting the comment.
- **A release pipeline**: `.github/workflows/release.yml` on a tag push, with every
  refusal in `deploy/ci-release.sh` and driven by `deploycheck` with no registry,
  no forge and no network. Plus a gitleaks job and a `.gitleaks.toml`
  that names the exact secrets rather than the files holding them.

- **The daemon**, **the control plane** and **the web UI**, as one AGPL-3.0-only
  workspace. The daemon owns coding-agent sessions and exposes them over HTTP and
  WebSocket; the control plane issues identity and relays every request; the web
  UI supervises the fleet from a phone. `README.md` is the overview and
  `deploy/README.md` is the deployment surface in full.
- **`claude`, `kimi` and `codex` over ACP**, normalized into one event stream.
  Sessions, permissions, questions, commands, file changes and uploads are the
  same shapes whichever agent is behind them.
- **A published container image for the control plane and the relay** —
  `ghcr.io/rends-east/reemoat/control-plane`, `linux/amd64`. Two services from one
  image, which is how `deploy/docker/compose.yml` already ran them. Running it is
  optional: `deploy/deploy.sh` still builds on the host by default.
- **`GET /v1/instance` serves the AGPL section 13 source offer** — the source URL
  and this version string — to callers who have not signed in, because they are
  the users that clause is owed to.
- **Ten checking drivers** and no test framework. Eight run offline in one
  process with no fleet, no agent and no deploy; `imagecheck` builds and starts a
  container; `harness` drives a real agent.

### Changed

- **The `reemoat-v` stream header is now enforced by the daemon.** It was written
  by the relay on every stream and read by nobody. A stream whose version
  disagrees with what the tunnel negotiated costs that one request (`501`), never
  the tunnel.
- **`endedWithDaemon` asks "is this a *final* reason?" rather than "is this a
  daemon reason?"** An exit reason a client has never heard of now reads as
  "coming back" and keeps the composer on screen, instead of taking it away from a
  conversation that was going to return.

### Not in this release

These are the three things most likely to be assumed about a self-hosted service
at 0.1.0, and none of them is true yet.

- **No sandbox.** An agent is a child of the daemon, with your uid, your files,
  your `~/.ssh` and your other repositories. Git hooks run as you, deliberately.
  This is the product rather than an oversight — `SECURITY.md` is the whole of
  what it does and does not promise.
- **No upgrade path from anything**, because there is no earlier version. The
  first upgrade this project has to get right is the one after this release.
- **No published daemon artifact.** The daemon is a checkout and a supervisor
  unit — `deploy/install.sh daemon` — and no binary, npm package or image is
  produced for it. Only the control plane ships as an image, because only the
  control plane is a thing that may be confined.

### Known and unmeasured

Written down because a release is where somebody decides whether to run this, and
these are open questions rather than hidden ones. `docs/DECISIONS.md` group Q7
holds them in full, with what would settle each.

- `linux/arm64` is not published. Nothing has built or started this image on
  arm64, and shipping a manifest entry the checks have never exercised is not a
  trade worth taking on the process that holds the fleet's signing key.
- The upload route's body-cancel behaviour under the auth and scope middlewares
  is unmeasured, and `SECURITY.md` says so rather than implying it was checked.
- Three agent-login questions on macOS are written but unmeasured, all settled by
  one real device-code login.

[Unreleased]: https://github.com/rends-east/reemoat/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/rends-east/reemoat/releases/tag/v0.9.1
[0.9.0]: https://github.com/rends-east/reemoat/releases/tag/v0.9.0
[0.8.0]: https://github.com/rends-east/reemoat/releases/tag/v0.8.0
[0.2.0]: https://github.com/rends-east/reemoat/releases/tag/v0.2.0
[0.1.0]: https://github.com/rends-east/reemoat/releases/tag/v0.1.0
