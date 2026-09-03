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

## Cryptography

Every cryptographic primitive is a Node.js built-in — `node:crypto` for Ed25519
token signing and scrypt password hashing, `node:tls` for the SMTP client. This
project bundles no cryptographic library of its own and implements no algorithm.

That last sentence is here for export control rather than for tidiness: this is
publicly available open-source software, published as source to anybody who wants
it, which is the category most jurisdictions treat as needing no license for
distribution. It is stated because "uses cryptography" is a question a legal
review asks and an unanswered one costs somebody a week.
