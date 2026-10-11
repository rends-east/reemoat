---
paths:
  - src/gateway/*
  - src/gateway/translate/*
  - src/gateway/signin/*
  - src/gateway/shape/*
  - src/acp/doors.ts
  - scripts/gatewaycheck*
  - scripts/doorprobe*
---

**A listener of this daemon's that a routed agent is pointed at in place of its vendor.**
The agent is handed a loopback address and a credential good for its own process; the
gateway adds the vendor's key on the way out. `agent-systems.md` answers which harness
reaches which system; this file answers what stands between them. Q7.155, Q7.157.

## Why it exists

- **It is the only way three of the four built-in routed rows are signed at all.**
  Claude Code replaces a header named `authorization` with a constant, and no other
  header reaches Z.ai. A request this daemon sends itself carries what each vendor
  documents. Q6.123.
- **It keeps the vendor's key from every agent**: not in `providers/set`'s headers,
  which the adapter puts on a command line, and not in an environment or a file, which
  is where three harnesses' doors are (Q3.515, Q6.125–Q6.127).
- **It refuses in a status a harness ends on.** Measured per harness: a 400 ends a turn
  at once with the sentence in the transcript; a 401 reads as the agent's own sign-in
  failing and replaces the agent; a 5xx is retried for minutes.

## Invariants

- **Loopback only, on a port the OS picks**, its own listener and never a route on the
  Hono app: that one sits behind the relay, the token gate and a body bound, and
  compresses what it answers. `PeerMcpEndpoint`'s shape (Q2.236).
- **One credential per agent process, closed with it.** `applySystem` opens the grant,
  or `launchThroughDoor` before the spawn, and hangs its `close` on `client.closed`, so
  a stop, a crash and a restart each end it; a resume opens another. Nothing persists
  the credential, and a daemon restart ends every agent anyway.
- **A request with `Origin`, or a `Host` that is not this listener's, is refused 403**
  before a credential is read: a page in a browser reaches loopback too, and a rebound
  name does. An unknown credential is 401.
- **The credential is taken as `x-api-key` or as a bearer.** Which one a harness sends
  is its door's fact (`HARNESS_DOORS`); claude's is `x-api-key`, since it overwrites
  the other.
- **Upstream headers are built, never copied.** `PASSED_REQUEST_HEADERS` names the few
  that describe the request; the vendor's key goes on last. The harness's credential,
  its session and installation ids and its cookies stop here.
- **`secretFor` takes a system and no harness**, and is read on every request: a key
  replaced mid-session signs the next turn, and a harness's own sign-in is not
  reachable from here. No `keyEnv` may name a subscription variable (Q7.156).
- **The model is held, never rewritten.** A request naming another model than the
  launch's is refused with both names. Rewriting it would run a model the harness's own
  control does not show.
- **A request leaves in the protocol its route ends in.** Where that is the harness's
  own the body goes out byte for byte; where it is another a `Translator` carries it
  and the request is this daemon's, so no header of the harness's describes it. The
  path is the protocol's own (`UPSTREAM_PATH`): an Anthropic base carries no version
  segment, the OpenAI ones do. A Messages request that names no version is sent one.
- **What the vendor answers is the harness's to read**, 401 and 403 excepted: those
  become a 400 saying this machine's key was refused, with the vendor's words bounded.
- **A cut on either side ends as a cut.** A harness that hangs up aborts the request
  upstream; a stream the vendor cut destroys the answer rather than finishing it.
- **`redirect: "error"`** on the one call (`upstream.ts`): a redirect would carry a key
  to an address no table named.
- **Switched off is a refusal, never a fallback.** `REEMOAT_MODEL_GATEWAY=off` leaves
  `SessionRuntime.openRoute` answering `null`, and a pairing that goes through the
  gateway refuses to start in a sentence. Nothing hands the harness the vendor's key
  instead.

## Doors

A door is how one harness is handed the gateway, and a row in `HARNESS_DOORS` exists
once it has been measured **closed** — that nothing of the conversation leaves by
another way — which is more than reaching the endpoint. `routeFor` reads the table: a
harness with a row is routed `via: "gateway"`, a plugin's harness `via: "direct"`.

| Harness | Door | State |
|---|---|---|
| claude | `providers/set` after the handshake, the credential as `x-api-key` | built |
| opencode | at the spawn: an inline config naming the model in all five places it reads one, in a home per harness | built, three protocols |
| grok | at the spawn: a `config.toml` in a home per session, the credential in a variable it names | built, three protocols |
| kimi, codex | measured, Q6.125 and Q6.124 | not built: Q7.158 says what each owes |
| cursor | none exists | a refusal |

- **A door set at the spawn asks the agent nothing**, so `routeFor` ignores
  `providers/list` for it, and the only place the pairing can be read back is the
  agent's own model control: `held(model)` is what it must show, `pinNativeModel` sets
  it and reads it again, and a start refuses where a resume demotes (Q2.216).
- **Its home is this daemon's** (`SessionRuntime.doorHome`, under `harness-homes/`):
  nothing of a person's config is merged under the door, no sign-in of theirs is there
  to spend, and their own sessions are left alone. grok's is per session because its
  file holds one default; nothing removes one yet.
- **`hostedProtocols` is what the app is sent** (`AgentRouting.hosts`) to intersect with
  `SystemInfo.protocols`. `daemoncheck` holds it to `hostable`'s answer on every cell.
- `pnpm doorprobe --door <harness>:door --gateway <protocol>` drives the production
  door of a real harness through the real gateway to the recorder.

## Translation

`TRANSLATIONS` in `acp/systems.ts` is what `routeFor` may end a route in; `TRANSLATORS`
is who carries each, and `gatewaycheck` holds the two lists to each other. One pair
exists: Messages into Responses, which is claude on OpenAI's API. Q7.159.

- **`routeFor` prefers a protocol both sides speak**, in the system's own order, and
  translates only where there is none. Only a route through the gateway may.
- **What a translator must remember rides the conversation.** A Responses reasoning
  item goes back to the harness packed in the thinking block's `signature`, marked
  `rmr1.`, and is unpacked in place on the next request; the real CLI returns it byte
  for byte across turns and a resume. Another vendor's signature is dropped. Nothing
  is kept in the daemon, so a restart loses nothing.
- **What a conversation holds and cannot be carried is refused, in a sentence naming
  it** (`gateway_untranslatable`), never sent short. A top-level request option the
  translator does not read is left behind instead: a harness adds one in an update, and
  refusing it would end every turn of every session.
- **A hosted tool of the harness's own vendor is dropped from the list**; the model is
  then never offered it.
- **An answer that never finished is a cut**: the stream is destroyed with no closing
  event, since a harness retries a cut and believes a short reply.
- **A token count has no counterpart** and is a 404, which claude is measured to
  survive.
- **Vectors are structure, never prose** (`vectors/gateway/*.txt`): recorded request
  shapes with every prompt replaced, since a harness's own prompt is its vendor's.

## A sign-in in place of a key

A system whose row names a `signIn` flow takes no key: `SystemCredentials` hands the
gateway its access token, and `SHAPES` what its requests must look like. `chatgpt` is
the one, and `REEMOAT_CHATGPT_PLAN` lists it. Q7.160.

- **Written from documentation and never driven.** Nothing about it is a measurement
  until somebody signs in with a real account; the entry says what only that can show.
- **A sign-in is spent by the gateway and handed to nobody**: `routeFor` refuses a
  harness with no door for such a system, and `PUT /systems/:system` refuses a key for
  one. A Claude subscription token is refused as any system's key (Q7.156).
- **One renewal for however many requests found the token stale**, and the new refresh
  token is stored before the new access token is spent: the old one is dead by then.
- **An attempt's state, verifier and nonce never leave the daemon.** A client is shown
  the page to open and nothing else, and opens it only on the flow's own origin.
- **The pasted address is a value, never a destination**: only the code and state are
  read, and only where it is this attempt's own `127.0.0.1` address and path.
- **Every call to a provider goes through `IdentityTransport`**; `identity.ts` is the
  fifth and last `fetch` in `src/`, and `gatewaycheck` names all five.

## Not built

- **A door for kimi or codex**, a translator for any other pair, and anything in the
  app for a sign-in. Q7.158, Q7.159, Q7.160.
- **A sentence for a harness that shows none.** kimi surfaces nothing an endpoint says
  (Q6.125), so its door owes a way into the transcript that is not the answer's body.
- **A subagent's model on claude.** Unmeasured; one that names another model is
  refused here by name.

## Bounds

| | |
|---|---|
| A request body | 32 MiB, held whole; past it 413 and nothing forwarded |
| In flight per credential | 16, then 429 |
| A vendor's refusal, read for its words | 4 KiB, 200 characters quoted |
| An answer held whole to be translated | 32 MiB; a stream is carried event by event and never held |
