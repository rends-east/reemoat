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
3. **All six sites move together, in one commit.** They are listed under *Cutting
   a release* below. A partial bump is worse than none, because the six disagree
   and every consumer of the version reads a different answer.
4. **The `CHANGELOG.md` heading is one of the six.** A version with no notes is
   not a version — `deploy/ci-release.sh` refuses to publish an empty section, so
   writing the entry is part of bumping rather than a step after it.
5. **Versions only ever go up**, compared as number triples rather than as
   strings: `0.10.0` is after `0.9.0`. Under 0.x the **minor** is the breaking
   one; see `CHANGELOG.md`'s header.
6. **A tag is a separate act from a push, and only a tag publishes.** Nothing is
   released, tagged or deployed by pushing to any branch, `main` included.

⚠ **None of this is enforced, and the gap is precise.** `pincheck` asserts the six
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

1. Set the new version in **all six places**: `package.json`,
   `packages/web/package.json`, `packages/control-plane/package.json`, the
   `VERSION` literal in `packages/control-plane/src/app.ts`, `DAEMON_VERSION` in
   `src/version.ts`, and a new dated heading in `CHANGELOG.md` with the
   `## [Unreleased]` content moved under it.
2. `pnpm pincheck` — this is what tells you whether you got five of them. The
   sixth, `app.ts`'s `VERSION`, is asserted by `relaycheck` instead, against the
   served `GET /v1/instance` response rather than against the file; `pincheck`
   prints a note saying so. Both are in `pnpm check`, so a missed one goes red
   before CI ever sees it.
   ⚠ What neither tells you is whether the version was bumped **at all** —
   every assertion compares the six sites to each other, never to a tag or to the
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

**No `Q<n>.<m>` citations in `CHANGELOG.md`.** Everywhere else a decision can be
cited by number and `docscheck` proves it resolves; that file is deliberately
outside the corpus, so a citation there is the one kind nothing checks.

