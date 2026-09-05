<p align="center">
  <img src="packages/web/public/favicon.svg" width="76" alt="">
</p>

<h1 align="center">Reemoat</h1>

<p align="center"><b>Your agents work. You sleep.</b></p>

<p align="center">
  <a href="https://github.com/rends-east/reemoat/actions/workflows/check.yml"><img src="https://github.com/rends-east/reemoat/actions/workflows/check.yml/badge.svg" alt="check"></a>
  <a href="https://github.com/rends-east/reemoat/actions/workflows/release.yml"><img src="https://github.com/rends-east/reemoat/actions/workflows/release.yml/badge.svg" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue" alt="license: AGPL-3.0-only"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D%2024-brightgreen" alt="node >= 24"></a>
</p>

## Overview

Coding agents run on **your** machine, with your files, your keys and your git.
Reemoat puts them behind a URL, so you can start one from bed, approve a command
from a train, and read what it did over breakfast — without leaving a laptop open
in a terminal you cannot see.

Several agents at once, each in its own git worktree. Close the lid, drop to LTE,
kill the tab: the daemon is the source of truth, and the agent never notices you
left.

## Install

On the machine you want agents to run on:

```
curl -fsSL https://github.com/rends-east/reemoat/releases/latest/download/install.sh | sh
```

It asks which control plane to join, installs the daemon, asks who you are on
that control plane — sign in, sign up, or paste a key — adds the machine, and
starts it. Nothing needs `sudo` and nothing is written to your shell profile. The
daemon and its checkout live under `~/.reemoat` and `~/srv/reemoat`. The
coding-agent CLIs are not part of `pnpm install`: `deploy/agents.sh` installs
three of them with each vendor's own installer, into the vendors' own directories
(`~/.local/bin`, `~/.local/share/claude`, `~/.codex`, `~/.opencode`), and kimi
from the npm registry into `~/.reemoat/toolchain`; the daemon re-runs it daily so
they stay current. Behind a firewall that blocks the vendors' hosts,
`… | sh -s -- --agent-source npm` installs all four from the npm registry instead
— your mirror, named the way npm is pointed anywhere (`~/.npmrc` or
`npm_config_registry`) — under `~/.reemoat/toolchain`. To take it off again,
`… | sh -s -- --uninstall`, which removes `~/.reemoat/toolchain` and with it any
CLI installed from npm; the vendor-installed CLIs stay, and so does every sign-in,
which lives in the vendors' own directories (`~/.claude`, `~/.codex`,
`~/.kimi-code`, opencode's data directory) that it does not touch.

**Where the software comes from and which fleet it joins are two questions, and
this command keeps them apart.** It downloads from this repository and joins
nothing until you say what to join — `--url https://your-control-plane`, or the
answer to the one question it asks. A control plane is the piece you run
yourself (`deploy/install.sh control-plane`); the author runs one at
`app.reemoat.com` for people who would rather not.

**Already have one running?** Its own copy of this installer has its address
already in it — Settings → Machines prints the command, and there is nothing to
type. `deploy/README.md` has the rest, including every flag.

## Self-hosted

Every piece runs on hardware you own — the daemon on your machine, the control
plane in a container on a box of your own. **Nothing here needs a hosted
service**: `deploy/install.sh control-plane` is the whole of it, and the fleet it
makes answers to nobody but you.

There is also a control plane at `app.reemoat.com`, run by the author, for people
who want the phone screen without a box to run. It is this code — `GET
/v1/instance` names the repository and the version it is running, which is the
AGPL section 13 offer — and it is one instance rather than the product. Which one
the command above joins is decided by which one you fetched it from.

## How it works

Three pieces, and you can run all of them yourself.

- **The daemon** owns the sessions. It spawns `claude`, `kimi`, `codex` or
  `opencode` over [ACP](https://agentclientprotocol.com), normalizes all four
  into one event stream, and exposes them over HTTP and WebSocket. It runs on
  your machine, as you. A plugin can add a fifth — any ACP program, and any
  inference endpoint to point one at — and it lands in the same lists.
- **The control plane** issues identity and relays every request. It holds the
  accounts, the machines and the grants, and it signs the short-lived tokens the
  browser uses. It runs in a container, on a box of its own.
- **The web UI** supervises the fleet from a phone. One screen, shaped around one
  question: *does anything anywhere need me?*

```
   you, anywhere             one box you run              machines you own
  ───────────────           ─────────────────            ──────────────────

                       ┌──────────────────────┐
  ┌──────────────┐     │    control plane     │   accounts, machines, grants
  │              ├────►│                      │   mints a short-lived token
  │    web UI    │◄────┤  /v1/*               │   whose `aud` is one machine
  │  on a phone  │     └──────────────────────┘
  │              │                                ┌─────────────────────────┐
  │  now holds   │     ┌──────────────────────┐   │  daemon   m_ab12        │
  │  a token     │     │        relay         │   │                         │
  │  for m_ab12  ├────►│                      ╞═══╡    claude   worktree A  │
  │              │     │  verifies it, checks │   │    codex    worktree B  │
  └──────────────┘     │  the grant, then     │   └─────────────────────────┘
                       │  picks the tunnel    │
                       │  named by `aud`      │   ┌─────────────────────────┐
                       │                      ╞═══╡  daemon   m_cd34        │
                       └──────────────────────┘   │                         │
                                                  │    kimi     worktree C  │
                                                  └─────────────────────────┘
```

## Documentation

| | |
|---|---|
| `CLAUDE.md` | The rules as they stand — what you need in order to *change* the code |
| `.claude/rules/` | The same, per area, loaded when you open a file it covers |
| `docs/API.md` | The HTTP surface of both services — 115 routes, what each is for, and the conventions every one of them answers in |
| `docs/PLUGINS.md` | Writing a plugin: the manifest, the host API, the drawing vocabulary, and what a plugin is trusted with |
| `docs/RELEASING.md` | Where the version is written down, when it moves, and what a tag does that a push does not |
| `docs/DECISIONS.md` | **Why** any of it is that way. 858 entries, question → decision, with the measurement behind each and the alternatives that were tried and taken back out |
| `deploy/README.md` | The deployment surface in full |
| `deploy/RELAYS.md` | Running more than one relay, and the order of operations |
| `CHANGELOG.md` | What changed in each release, and what a 0.x minor is allowed to break |
| `SECURITY.md` | What is known and accepted, what is in scope, and how to report privately |

## License

Third-party licenses, and the one dependency that is **not** open source, are in
[`THIRD-PARTY.md`](THIRD-PARTY.md).
