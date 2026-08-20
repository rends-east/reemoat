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

[Unreleased]: https://github.com/rends-east/reemoat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rends-east/reemoat/releases/tag/v0.1.0
