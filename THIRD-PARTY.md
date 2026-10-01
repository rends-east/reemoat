# Third-party components

This project is AGPL-3.0-only. **The dependency worth knowing about before a legal
review is the one that is not open source at all**, and that is what this file is
for.

There is deliberately no table of every dependency and its license here. `package.json`
and `pnpm-lock.yaml` are that list, they are machine-readable, and they cannot go
stale — a hand-written copy beside them can, and would, and nothing here would
catch it. Run `pnpm licenses list` for a current one.

## The one that is not open source

`pnpm install` fetches **`@anthropic-ai/claude-agent-sdk`**, which declares
`"license": "SEE LICENSE IN README.md"` — a proprietary license, not an OSI one.
It arrives as a transitive dependency of `@agentclientprotocol/claude-agent-acp`,
which is itself Apache-2.0. The platform binaries it declares
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, `SEE LICENSE IN LICENSE.md`)
are **excluded**: every one is named in `pnpm-workspace.yaml`'s `overrides` with
`-`, so no binary of it lands in `node_modules` — the JavaScript package alone
does.

Three facts bound what that means here:

- **No code from it is ever loaded.** The daemon spawns an agent as a subprocess
  over ACP, and nothing in `src/`, `packages/control-plane` or `packages/web`
  imports it. Two comments in `src/acp/agents.ts` name it — the `ULTRACODE_SETTING`
  docblock, quoting the SDK's own note on that session flag, and the `AGENT_LOGIN`
  docblock, recording where the `claude` binary used to ship — and a comment loads
  nothing. The one place in this repository that *resolves* it is
  `scripts/pincheck.ts`, through the adapter, to read the manifest beside its
  entry point — the platform packages it declares, held against the overrides
  list above. A resolve returns a filename; it evaluates nothing. This is called
  out because a grep for the package name finds those three places, and a reader
  who had been told there is "no import anywhere" would reasonably read one as a
  contradiction.
- The **published container image contains none of it**, and that is asserted
  rather than intended: `scripts/imagecheck.ts` fails if any
  `@agentclientprotocol`, `@anthropic-ai`, `@modelcontextprotocol`, `@openai` or
  `opencode-*` package reaches the image. The last of those was the heaviest —
  `opencode-ai`'s install unpacked one ~144 MB platform executable — and is no
  longer a dependency at all; the pattern stays as the guard. The control plane
  and the relay are the only things this project publishes as an artifact, and
  neither spawns an agent.
- It is only needed to run `claude`. A deployment using `kimi`, `codex` or
  `opencode`, or one that only runs the control plane, does not need it. The
  `claude` CLI itself is not in this tree at all: `deploy/agents.sh` installs it
  from the vendor — or, under `--source npm`, from the npm registry as
  `@anthropic-ai/claude-code` — under the vendor's own terms, exactly as a
  `curl | sh` install of it in a terminal would be.

If a fully-permissive dependency tree is a requirement for you, drop
`@agentclientprotocol/claude-agent-acp` from the root `package.json`; the other
three agents keep working, and `pnpm pincheck` will tell you which adapters are
actually installed.

Using the agents themselves is subject to each vendor's own terms, which this
project neither grants nor restricts.

## Everything else

Permissively licensed, and the manifests are the record: MIT, Apache-2.0,
BSD-3-Clause and ISC across the runtime and build dependencies. Nothing else in
the tree carries a license that restricts redistribution, and the AGPL obligations
this project takes on are its own rather than inherited.

## Text adapted from elsewhere

Not a dependency and not code, but it arrives under somebody else's licence and a
legal review asks about it, which is what this file is for. The three documents in
`packages/web/src/legal/` — Terms of Use, Acceptable Use Policy, Privacy Policy —
are adapted rather than written from nothing.

| Source | Licence | Used by |
|---|---|---|
| [37signals open-source policies](https://github.com/basecamp/policies) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | All three documents: structure and much of the wording |
| [`github/site-policy`](https://github.com/github/site-policy) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | The Acceptable Use Policy's restriction lists |

**CC BY 4.0 asks for the attribution where the work is read**, so it is rendered
on each page as well as recorded here, and `webcheck` asserts every field of that
credit. The CC0-licensed text owes nothing and is credited anyway — telling the
two apart at a glance is the mistake that would turn a courtesy into a breach.

⚠ **These documents name one operator and are that operator's terms, not this
software's.** A fork serving them unchanged is making a statement about a party
with no relationship to its users; the header of `legal.ts` says so where the value
is, in `SOURCE_URL`'s shape.

## Marks drawn in the app

The six harness icons (`packages/web/src/ui/AgentIcons.tsx`) are their vendors'
marks — Anthropic's Claude, OpenAI's Codex, Moonshot AI's Kimi, opencode's, xAI's
Grok and Anysphere's Cursor — and belong to them. They are drawn only to name the
program a session runs, never as this project's own. The SVG paths are as published in
[`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) 1.95.1, MIT,
Copyright (c) 2023 LobeHub.

## Cryptography

⚠ **This section changed, and the change is the reason it exists.** It read *"this
project bundles no cryptographic library of its own and implements no algorithm"*
for as long as there was no end-to-end encryption. Both halves of that are now
qualified rather than true, and a legal review that found the old sentence beside
the current tree would rightly stop.

**Primitives still come from libraries, and no algorithm is implemented here.**
`node:crypto` does Ed25519 token signing and scrypt password hashing; `node:tls`
carries the SMTP client. The end-to-end encryption between the app and a daemon
adds four audited, zero-dependency packages, all MIT:

| Package | Version | Provides |
|---|---|---|
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | 2.4.0 | X25519 |
| [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) | 2.4.0 | ChaCha20-Poly1305 |
| [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | 2.4.0 | BLAKE2s, HMAC |
| [`x25519-dalek`](https://github.com/dalek-cryptography/curve25519-dalek) | 3.0.0 | X25519 in the native shell, so a device's private key never crosses into the webview |

That is a real change in posture for a project whose control plane runs on three
dependencies in total, and it is recorded here rather than left in a manifest.

**What *is* assembled here is a published protocol, not a primitive.**
`packages/protocol/src/noise.ts` implements the handshake described by the Noise
Protocol Framework (revision 34), pattern `IK`, suite
`Noise_IK_25519_ChaChaPoly_BLAKE2s`. No primitive is written: the state machine is
the part a library would otherwise have supplied, and `pnpm protocolcheck` drives
it byte-for-byte against the official cross-implementation test vectors in both
roles, with fixed ephemerals. The vectors themselves are vendored at
`packages/protocol/vectors/noise.txt` from the `snow` project's published
cross-implementation file (Noise is a public-domain specification; the vector file
is distributed under snow's own permissive terms).

**And for export control**, which is what the paragraph below was always for: the
algorithms used are standard, published and widely available — X25519, ChaCha20-
Poly1305, BLAKE2s, Ed25519, scrypt — and none is authored here. This is publicly
available open-source software, published as source to anybody who wants it, which
is the category most jurisdictions treat as needing no license for distribution. It
is stated because "uses cryptography" is a question a legal review asks and an
unanswered one costs somebody a week.
