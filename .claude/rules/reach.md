---
paths:
  - packages/web/src/reach.ts
  - packages/web/src/ui/connection.ts
  - packages/web/src/ui/ConnectionPill.tsx
  - packages/web/src/ui/Unreachable.tsx
  - packages/web/src/ui/AccountRow.tsx
  - packages/web/scripts/webcheck.reach.ts
  - packages/web/scripts/webcheck.connection-pill.ts
  - packages/web/src/echo.ts
  - packages/web/src/ui/past.ts
  - packages/web/scripts/webcheck.bad-network.ts
  - packages/native/src-tauri/src/proxy.rs
---

# What could not be reached, and where it is said

The client's loading and failure states. `relay.md` owns the wire and `web-shell.md` the
list as a layout. Q3.707 to Q3.716; what is not built yet is listed at the foot of Q3.709.

## Three facts, never one string (Q3.707)

`reach.ts` is pure and store-free: `store.ts` reads it, and so may the gate bundle.

- **`device`**: offline only on a positive signal (`navigator.onLine === false`, or an
  `offline` event through `noteDevice`). `true` proves nothing, so nothing is keyed on it.
  **Offline renames a failure and is none by itself**: a server on this same computer
  answers with the network off. Going offline asks the listing at once, and only what
  failed is then called "network"; a server that answered with an error keeps its name.
- **`server`**: `unknown`, `ok`, `unreachable`, `refusing`, with `since`. **Written only by
  a listing's own answer and cleared only by a listing that succeeds.** `since` is the
  monotonic start of the attempt that failed first, kept across the two kinds.
- **`registry`**: `unknown`, `failed`, `known`; `known` is sticky while its server is down.
- **A read that can fail has three answers**: `sessionsFailed` beside `listed`,
  `pluginsRead`, `configRead`, `meRead`. A new one owes the third; a `null` or an empty
  list alone cannot tell not-asked from failed.
- **Evidence asks, it never writes.** A degraded token or a machine offline for
  `cp_unreachable` (`serverEvidence`) makes `tick` ask the listing at `OFFLINE_RETRY_MS`,
  and the listing says which it is. Such a machine is never named as its own trouble
  (`wantsServer`).
- **A machine down on the wire is in doubt until the server answers** (`doubted`, from
  `wireDownSince` and `doubtedOf`): a full outage takes the relay first. `tick` asks the
  listing at once, and until it answers the machine is not named: a reconnect in the
  pill, a skeleton in an empty tab. Its answer alone names nothing (Q3.716).
- `cpError` stays as the failure's text and as `tick`'s reason to ask again; no screen
  decides anything on it.
- **The sentences are written once**: `NO_NETWORK`, `WAITING_FOR_NETWORK`, `serverWords`,
  `machinesWords`, `sessionsWords`. The server by its host (`serverLabel`, which keeps
  `http://`), "network" and never "internet", contractions, and a machine by its own
  label, never the `local` this computer is drawn as (`machine-gestures.md`).

## An unread list is never called empty (Q3.709)

- **`listBody` (`ui/groups.ts`) is the one answer** to what a list with nothing to draw
  says: total, first match wins, driven over a grid whose rules are properties and never
  a count. A new kind owes a rule there and an entry in the reached-kinds difference.
- **An empty-state sentence about machines, sessions, plugins or the server is drawn only
  from `known`**: through `listBody` in the list and the pane, through `registryUnread`,
  `configUnread`, `pluginsUnread` or `MeUnread` everywhere else. `webcheck.reach.ts` holds
  a census of the guarded files and finds every screen that draws `MACHINE_GONE` as a body.
- **`Unreachable`** is the block for a body with nothing to draw: the sentence, `Try
  again`, and for a server the other accounts as `AccountRow`s. Accounts never inside a
  sheet (`accounts={false}`) and never when the device is offline; they come from
  `host_accounts`, which reads no keyring and no network.
- **At `lg`** with no machine held and no conversation open (`splits`), the rail draws the
  sentence and the pane the control and the accounts, as "No machines yet." is split.
- **A machine's tab is settled by that machine alone**, never by the fleet.
- **`Try again` owns its attempt**: `store.retry()` starts a pass or adopts the one out,
  drawn for at least `RETRY_FLOOR_MS`, and puts the automatic listing off a full interval.
  On success the block is gone, so a keyboard's focus goes to the list and the list's own
  live region says "Connected".

## One pill, and when it is silent (Q3.659, Q3.710)

**One pill, bottom-left, no banner**; nothing is drawn above conversations. `webcheck`
asserts the old banner and `reconnecting` line absent.

- `connectionTrouble` takes a monotonic clock. Order: the server (a reconnect for
  `SERVER_NAMED_AFTER_MS`, then named; named at once when it answered with an error), a
  machine by name, the open conversation's stream, a first probe or first listing. On a
  device that says it is offline whatever was found reads "Waiting for network…".
- Only `no_route` or no reason names a machine; `over_limit`, `owner_disabled`,
  `not_enrolled`, `no_token`, the key refusals and session notices stay where drawn.
- Reads this screen, not the fleet: the tab plus the open conversation's machine and
  stream; under All a probe counts and an off machine does not.
- **Silent where the body speaks** (`silent`, from the list's own `onSpeaks`): one place
  says it.
- A daemon the host is starting is *Connecting…* (`localDaemonStarting`). Q3.692.
- **Under a coarse pointer it opens by itself for every cause but a reconnect**
  (`opensByItself`): one class on the default arm, no `matchMedia`. The tap reads
  `offsetWidth` and folds or opens from what the stylesheet drew.
- A long host truncates (`max-w-full min-w-0`, the words in `truncate`); never
  `whitespace-nowrap`.
- `troubleSince` keeps one spell across kinds. When it is drawn is the next section's;
  the live region is permanent: a spell announced once, a retry never.
- Shield only down the relay (Noise); TLS and loopback do not earn it.
- In the list's pager window, never over New session. Below `lg` a conversation draws its
  own (`lg:hidden`), lifted over a parked card; above `lg` the list's reads that
  conversation. Exactly one is displayed.
- A wake redials only what was proved before the absence *began* (`WakeClock`,
  `suspectSince`, monotonic). Q3.703.

## A drop shorter than the quiet window is drawn nowhere (Q3.714)

One window, `RECONNECT_QUIET_MS`. Whatever is inferred from a failure is drawn only once
it has outlasted it, counted from the cause's own start on the monotonic clock.

- **The store publishes what is drawn; the facts stay inside it.** `AppState.machines`
  holds `drawnReach` and `AppState.server` holds `drawnServer`; the poll, `doubted` and
  every retry read `connection.state()` and `serverRaw`. Logic that reads the drawn state
  acts five seconds late, and a screen that reads the fact flickers.
- **A machine found down keeps what it was drawn as** (`drawnAs`), dated by `downAt` over
  `retriedDown`: the wire, or the server its token is minted by. Any other reason is an
  answer and is drawn at once. One never drawn as up is held only while `relayOnline`.
- **A spell once drawn stays drawn until it ends**: a machine drawn as down is not drawn
  as up again while it is still down, and a change of cause takes nothing back from the
  pill (`troubleLive`). The device saying offline and back inside one hold did both.
- **A positive word waits the grace, not the window** (`troubleWait`): the device saying
  it is offline, or the server answering with an error. Nothing is held on a device that
  says it is offline; `noteDevice` sets the word before weighing anything under it.
- **Each cause carries its own date** (`Spell.since`): `server.since`, `downSince`, the
  stream's `downSince`. A first listing and a first probe carry none and are counted from
  when the screen first saw them (`troubleDue`), so a launch is one spell. **None is drawn
  on the render that first sees it** (`TROUBLE_SIGHT_MS`): a hold that has just run out
  hands over a cause already due, and the body reports that it speaks one commit late.
- **A machine drawn as up whose sessions cannot be read is a reconnect**
  (`listFailingSince`, from the first listing that failed in transit). A probe can pass
  for ever while a listing times out, and such a machine is never drawn as down.
- **The working line** is stale by `usePast(stream.downSince)`, never by the phase, and a
  conversation just opened is dated from its opening. `downSince` is set once per loss:
  a retry that fails must not move it, or a line that retries every few seconds never
  goes stale.
- **Recovery is drawn at once**, and the pill then stays `TROUBLE_MIN_SHOWN_MS`
  (`troubleShown`). Its words are kept only for a spell that is due (`live`).
- **A first failure is asked again soon** (`retryDelay`), for a probe and for the
  listing. `soon` sets an early pass, `tick(true)`, which asks again about what is down
  or unread and leaves what answers to the poll; the poll's own interval is the backstop.
  A machine that is up, by whatever door, has its count and its next probe cleared in
  `publish`.
- A timer that fires a hair early finds its wait unspent: `usePast` counts it
  (`crossed`), the pill sets it again (`turn`), `releaseHolds` weighs again.
- `webcheck.bad-network.ts` counts what is drawn against the facts (`Flicker`) and
  asserts nothing shorter than the window is drawn (`early`).

## A link that is back is asked about at once (Q3.716)

Nothing says the link is back: WebKit reads online while a VPN's interface has an
address, and Android's shell is told nothing, so the first word never shows there. The
retries are the detector. The driver holds every outage to `BACK_WITHIN_MS`
(`BAD_NETWORK_OUTAGE=60`).

- **What nothing answered is asked at `DOWN_RETRY_MS`**, the poll's own pace, after 1 and
  2 s; a refusal keeps `OFFLINE_RETRY_MS` (`listingWait`).
- **A listing still out holds nothing back** past `LISTING_HEDGE_MS` (`listingFree`):
  waited for, it costs its whole timeout. Answers stand in the order asked
  (`listingLanded`), a retry paced from the newest ask. So too with no machine held, and
  on `Try again`.
- **The first to answer asks for the other, once.** A machine back has a server still
  unreachable asked now, once a spell (`machinesBack`, `serverNudged`); the server back
  has each machine down probed now. A wake starts counts over, bar a refusal's.
- **A listing's failure is confirmed before it is drawn**: `SERVER_CONFIRM_MS` from when
  it landed (`serverDrawnAt`), since a timed-out ask lands with its window spent.
- **A machine is named only on a probe begun after the first listing to answer since it
  went down** (`answeredFor`, `provedDown`). Held to the newest, each listing put what
  was named back in doubt. A probe begun before it is asked again at once, and `doubt`
  asks the listing only where none has answered.
- **A daemon not dialled in is asked after through the listing** (`undialled`,
  `awayAsks`), up to `AWAY_RETRY_MS` apart: nothing on the wire says it is back.
- **Passes that meet in one probe count its failure once** (`probe`); the early pass
  sets itself again for what is due next (`nextDue`).
- **The host's connection is pinged** (`proxy.rs`): reqwest rides one the network
  dropped for ever. Q6.122.

## The shell at once (Q3.708)

`App.tsx` keeps a spinner for one wait: the host has not named an account
(`state.host === null` in the shell). No request is out during it; past
`STARTING_WORDS_MS` it says so. A rejected boot call is `hostBootFailed`, a failure with a
reload. Everything after is the shell, loading or not, so the drawer is always in reach.

**What the shell may claim before the first answer: nothing.** The drawer's two
destinations are drawn disabled, never mounted late; the bell reads "Not checked yet";
New session and the column's Add are disabled; Account and API keys draw `MeUnread`; an
admin section refuses only an account that was read. A control added to the shell owes
the same question: what does it say while `registry` and `meRead` are `unknown`?

## What a late or lost answer may not undo (Q3.711 to Q3.713)

On a slow link answers overtake each other, and arrival order proves nothing.
`webcheck.bad-network.ts` runs the real store, connection and stream on a virtual clock
over such a link; a rule here is a property it sweeps, so drive it before changing one
(`BAD_NETWORK_EXPLORE=300`, or `BAD_NETWORK_TRACE=slow:stays:1042` for one schedule).

- **`supersedes` decides which snapshot stands**: an older log (`lastSeq`) never replaces
  a later one, from a listing, a frame or a POST's answer; between two reads of one log a
  listing wins only if it was *asked* after the row last moved (`readClock`, `rowAsOf`).
  A daemon that started again (`instanceId`) is its own order.
- **Whatever names a session confirms it as it lands**, a stale answer included; the stamp
  only moves forward. **A listing prunes only rows nothing confirmed since it was asked**,
  and one listing per machine is out at a time (`polling`, keyed on the epoch).
- **The conversation on screen stays wanted when forgotten** (the newest of `streamOrder`),
  or its row coming back leaves it blank: the view opens a session once per reference.
- **Every door events come in by claims the echo**: `onEvents`, `loadAll`, `primeBlocked`.
  So the echo's floor is `sendFloor`'s, the later of the transcript's tail and the row's
  `lastSeq`: an empty conversation's floor of zero lets old words in a page claim a send.
- **A failed send is weighed before anything is given back**: `echoClaimed` means only the
  answer was lost. Else a failure in transit is `doubtSend`, and its event arriving takes
  the copy back out of the box, unless the reader changed it. A refusal is never in doubt.
- Not built: an idempotency key on the prompt route, which is what exactly-once needs.

## Bounds

| | |
|---|---|
| A drop that is drawn nowhere | `RECONNECT_QUIET_MS` 5 s |
| A positive word before it is drawn | `TROUBLE_GRACE_MS` 1 s |
| The pill, once drawn | at least `TROUBLE_MIN_SHOWN_MS` 1.5 s |
| A probe or a listing nothing answered | at 1, 2 s, then every `DOWN_RETRY_MS` 4 s; refused, every `OFFLINE_RETRY_MS` 15 s |
| A listing's failure before it is drawn | `SERVER_CONFIRM_MS` 2.5 s from landing, and the window |
| A listing out before another is asked beside it | `LISTING_HEDGE_MS` 1 s |
| A daemon not dialled in | the listing at 1, 2, 4 s, up to `AWAY_RETRY_MS` 60 s |
| The host's connection, silent | pinged at `PING` 5 s, closed 5 s later; a dial has `CONNECT` 10 s |
| A reconnect before the server is named | `SERVER_NAMED_AFTER_MS` 10 s |
| A registry that failed, nothing held | asked on that same schedule; the poll's 4 s is for a known, empty registry |
| A press on `Try again` | drawn for at least `RETRY_FLOOR_MS` 400 ms |
| Words on the pre-boot wait | `STARTING_WORDS_MS` 2 s |
