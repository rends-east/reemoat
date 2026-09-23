# Releasing

Everything the version number touches: where it is written down, when it moves,
and what a tag does that a push does not.

Split out of `CONTRIBUTING.md` when that file was removed. None of this is about
accepting somebody else's patch — all of it is needed by whoever cuts the
release, which is currently one person.

## Versioning

**Every push carries a version bump. A push is a publication of code, so the
version moves with it — including a push to a working branch.**

The rules, in full:

1. **A branch push must carry a version strictly greater than `main`'s.** Bump
   once per branch, at the start rather than at the end: every later push on that
   branch is then already ahead, and nothing has to be redone at merge time. If
   `main` moves past you while you work, rebase and bump above it again.
2. **`main` holds the released version.** Pushing to `main` is what makes a
   version current; the branch it came from is what proposed it.
3. **All seven sites move together, in one commit.** They are listed under *Cutting
   a release* below. A partial bump is worse than none, because the seven disagree
   and every consumer of the version reads a different answer.
4. **The `CHANGELOG.md` heading is one of the seven.** A version with no notes is
   not a version — `deploy/ci-release.sh` refuses to publish an empty section, so
   writing the entry is part of bumping rather than a step after it.
5. **Versions only ever go up**, compared as number triples rather than as
   strings: `0.10.0` is after `0.9.0`. Under 0.x the **minor** is the breaking
   one; see `CHANGELOG.md`'s header.
6. **A tag is a separate act from a push, and only a tag publishes.** Nothing is
   released, tagged or deployed by pushing to any branch, `main` included.

⚠ **None of this is enforced, and the gap is precise.** `pincheck` asserts the seven
sites agree *with each other* — it captures the root manifest's version and
compares the rest to that. There is no external reference anywhere in it: no git
tag, no previous commit, no diff. So a **partial** bump goes red immediately, and
a **missing** bump is green everywhere — `pnpm check` passes, CI passes, and the
first thing that notices is `deploy/ci-release.sh` refusing the tag, which is
long after the push this rule is about.

Closing it means giving a check an external reference, which means reading
`origin/main` from git. Two things make that more than a small edit, and both are
measured rather than assumed: `check.yml`'s `actions/checkout` takes the default
`fetch-depth: 1`, so `origin/main` does not exist in CI at all (`git rev-parse
origin/main` exits 128) and the workflow would have to fetch it; and
`git rev-parse --abbrev-ref HEAD` returns the literal `HEAD` on a tag push and on
a pull request, so branch detection that trusts it reads a wrong answer rather
than failing. Until somebody does that work, **this section is a rule people keep,
not a rule the tree enforces** — which is the one state this repository otherwise
refuses, and it is recorded here rather than left to be discovered.

## Cutting a release

A release is a tag push. Everything before that is by hand and in this order,
because the tag is what triggers the publish and the publish refuses a tag the
tree disagrees with:

1. Set the new version in **all seven places**: `package.json`,
   `packages/web/package.json`, `packages/control-plane/package.json`,
   `packages/protocol/package.json`, the `VERSION` literal in
   `packages/control-plane/src/app.ts`, `DAEMON_VERSION` in `src/version.ts`, and
   a new dated heading in `CHANGELOG.md` with the `## [Unreleased]` content moved
   under it.
2. `pnpm pincheck` — this is what tells you whether you got six of them. The
   seventh, `app.ts`'s `VERSION`, is asserted by `relaycheck` instead, against the
   served `GET /v1/instance` response rather than against the file; `pincheck`
   prints a note saying so. Both are in `pnpm check`, so a missed one goes red
   before CI ever sees it.
   ⚠ What neither tells you is whether the version was bumped **at all** —
   every assertion compares the seven sites to each other, never to a tag or to the
   previous commit. Forgetting the bump entirely is green everywhere.
3. Commit, push, wait for `check` to go green on that commit.
4. `git tag v<version> && git push origin v<version>`.

`.github/workflows/release.yml` takes it from there and decides nothing:
`deploy/ci-release.sh` holds every refusal — a disagreeing manifest, a commit
whose `check` run is not green, a tag that already has a release or an image, an
empty changelog section — and `deploycheck` drives all of them offline.

The `VERSION` literal is the one worth not forgetting. It is served as the AGPL
section 13 source offer, so a release that moves the tag and not the literal
publishes an offer naming a version whose source nobody can fetch.

## The native app in a release

Not a version question, and that part is unchanged: `packages/native` carries two
`version` fields and **neither is a release site** — `tauri.conf.json` names a
*path* to the root manifest and `Cargo.toml` is pinned inert at `0.0.0`, both
asserted by `pnpm nativecheck`. So the seven above stay seven and a native build
needs no line in step 1. That sentence is load-bearing in a new way now: an app
artifact carries a version in its **file name**, derived from the tag, and derived
is what keeps it from being an eighth site.

**A tag builds and publishes the app.** `deploy/ci-release.sh`'s `app` verb builds
one target and names the artifact it produced; `publish` puts every one of them on
the same `gh release create` call as `install.sh`, and refuses a release missing an
artifact its own list named. `.claude/rules/native-packaging.md` has which platform
gets a daemon inside it and which gets a client.

**`release.yml` runs it as two jobs — `app`, a matrix, and `app-android`, one job
— and neither holds a list of its own.** `plan` emits the matrix as JSON off the
same table `app_triple` and `app_artifacts` are columns of, so adding a target is
`RELEASE_APP_TARGETS` plus a `check.yml` leg and no workflow edit. Android is
separate because it is the only target that reads a signing key and a matrix
cannot scope a secret to one entry; the four secrets are named in that job alone.

**Which server the apps open on is a repository variable, and checking it is a step
before the tag.** `release.yml` forwards `REEMOAT_DEFAULT_SERVER` from
`${{ vars.… }}` to both app jobs, and each job's summary prints the value it
compiled in. It is set in the forge, never in a file, so `gh variable list` before
`git tag` is the only place to see it: unset, every app built from that tag opens on
an empty, editable server box rather than on this repository's server, and nothing
fails. A fork inherits no repository variables, which is the point. Q4.127.

⚠ **`RELEASE_APP_TARGETS` is empty today, so a tag still publishes only the
installer.** That is the gate rather than a gap: `deploycheck` asserts every name
in that list is built by a `check.yml` job, so a platform is added to it in the
same change that gives it one. Until then the machinery exists, is driven offline,
and publishes nothing — which is the state it should be in, because the first build
of a platform in this project's history must not happen on the release path.

⚠ **Empty means both app jobs are *skipped*, and three lines make that safe.**
`plan` emits an empty matrix; each app job carries an `if:`, because an empty
matrix in GitHub Actions is a job that **fails** rather than one that skips; and
`publish` carries the only `if:` in a file whose header says it decides nothing,
because GitHub skips a job whose `needs` includes a skipped one — without it,
wiring the app jobs up would have stopped every release creating a release page at
all, after `manifest` had already pushed the image tags. `deploycheck` reads all
three back, along with the script's `case` against the workflow's `run:` lines in
both directions — the check that did not exist while the `app` verb had no caller.

**What a release does not do is sign anything.** macOS and Windows artifacts are
**unsigned**: Gatekeeper and SmartScreen will both warn, and the remedy is a
certificate rather than code. Android is the exception — an APK that is not signed
installs on nothing, so `app` refuses that target unless all four of
`RELEASE_ANDROID_KEYSTORE`, `RELEASE_ANDROID_KEYSTORE_PASSWORD`,
`RELEASE_ANDROID_KEY_ALIAS` and `RELEASE_ANDROID_KEY_PASSWORD` are set, and names
the one that is missing. They are scoped to that job alone, which is why `plan`
does **not** ask for them: `plan` is the job whose whole property is that it can
write nothing anywhere.

What a *signed* macOS build needs is entirely environment — an Apple Developer ID
certificate and the notarization variables — so no file in this repository changes
to produce one. `docs/NATIVE.md` carries the three signatures and which of them are
which. **There is deliberately no updater**, so a build is replaced by downloading
the next one; `docs/NATIVE.md` records that this is a one-way door for everything
already shipped.

⚠ **AGPL §6 rides the notes.** Conveying a binary is a distribution, and
`bundle.licenseFile` is read by the `dmg` and `nsis` bundlers and by nothing that
builds a macOS `.app`. So `plan` appends a source offer naming **this tag** —
`main` is routinely ahead of every tag — derived from `app.ts`'s `SOURCE_URL`, so a
fork that obeys the licence instruction gets a correct offer for free.

**No `Q<n>.<m>` citations in `CHANGELOG.md`.** Everywhere else a decision can be
cited by number and `docscheck` proves it resolves; that file is deliberately
outside the corpus, so a citation there is the one kind nothing checks.

