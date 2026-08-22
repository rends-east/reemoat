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

## Self-hosted

Every piece runs on hardware you own — the daemon on your machine, the control
plane in a container on a box of your own — and there is no hosted service to sign
up for.

## How it works

Three pieces, and you can run all of them yourself.

- **The daemon** owns the sessions. It spawns `claude`, `kimi` or `codex` over
  [ACP](https://agentclientprotocol.com), normalizes all three into one event
  stream, and exposes them over HTTP and WebSocket. It runs on your machine, as
  you.
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
| `docs/API.md` | The HTTP surface of both services — 102 routes, what each is for, and the conventions every one of them answers in |
| `docs/PLUGINS.md` | Writing a plugin: the manifest, the host API, the drawing vocabulary, and what a plugin is trusted with |
| `docs/RELEASING.md` | Where the version is written down, when it moves, and what a tag does that a push does not |
| `docs/DECISIONS.md` | **Why** any of it is that way. 693 entries, question → decision, with the measurement behind each and the alternatives that were tried and taken back out |
| `deploy/README.md` | The deployment surface in full |
| `deploy/RELAYS.md` | Running more than one relay, and the order of operations |
| `CHANGELOG.md` | What changed in each release, and what a 0.x minor is allowed to break |
| `SECURITY.md` | What is known and accepted, what is in scope, and how to report privately |

## License

Third-party licenses, and the one dependency that is **not** open source, are in
[`THIRD-PARTY.md`](THIRD-PARTY.md).
