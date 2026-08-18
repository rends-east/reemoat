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
which is itself Apache-2.0, and it carries a platform binary
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, `SEE LICENSE IN LICENSE.md`).

Three facts bound what that means here:

- **No code from it is ever loaded.** The daemon spawns an agent as a subprocess
  over ACP, and nothing in `src/`, `packages/control-plane` or `packages/web`
  imports it. There is exactly one line that names it — `vendoredClaude` in
  `src/runtime/local.ts` calls `createRequire().resolve()` on it to find the path
  of the `claude` binary shipped inside it, the same way the adapter finds it. A
  resolve returns a filename; it evaluates nothing. This is called out because a
  grep for the package name finds that line, and a reader who had been told there
  is "no import anywhere" would reasonably read it as a contradiction.
- The **published container image contains none of it**, and that is asserted
  rather than intended: `scripts/imagecheck.ts` fails if any
  `@agentclientprotocol`, `@anthropic-ai`, `@modelcontextprotocol` or `@openai`
  package reaches the image. The control plane and the relay are the only things
  this project publishes as an artifact, and neither spawns an agent.
- It is only needed to run `claude`. A deployment using `kimi` or `codex`, or one
  that only runs the control plane, does not need it.

If a fully-permissive dependency tree is a requirement for you, drop
`@agentclientprotocol/claude-agent-acp` from the root `package.json`; the other
two agents keep working, and `pnpm pincheck` will tell you which adapters are
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
