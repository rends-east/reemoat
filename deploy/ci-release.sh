#!/bin/sh
# What a runner does to publish a release, as a script rather than as YAML.
#
# The same argument `ci-deploy.sh` opens with, applied to the other act: a
# workflow file is exercised by pushing and watching, so anything in one that
# *decides* something is a decision no driver can reach. `release.yml` is
# therefore a checkout and four calls, and every refusal below is driven by
# `deploycheck` with no registry, no forge and no network, through five seams:
#
#   GH            — how the commit's CI verdict is read, and how the release is
#                   created. A stub in the driver, so the green path and every
#                   red one are both exercised.
#   DOCKER        — every call that would reach a registry. `echo` in the driver,
#                   so the exact build argv is an assertion rather than a hope.
#   RELEASE_ROOT  — the tree whose versions are read. Pointed at a synthetic
#                   fixture, which is what makes "refuse a tag the manifests
#                   disagree with" testable at all without committing six
#                   deliberately-wrong manifests.
#   TAURI         — the app bundler. `echo` in the driver, for `DOCKER`'s reason:
#                   which bundle kind and which target triple reach it is an
#                   assertion rather than a hope.
#   NODE          — the daemon payload's staging step. Un-prefixed like the two
#                   above because it is a program this script runs, not a value
#                   it reads.
#   APKSIGNER     — the Android signature check. A seam for `GH`'s reason rather
#                   than `DOCKER`'s: its answers matter, and so does what it
#                   prints about which schemes verified — so the driver stubs a
#                   verifier for each kind of APK (both schemes, v2 alone, the
#                   JAR signature alone) and one that verifies nothing, and none
#                   of them needs an Android SDK on the machine running the
#                   driver.
#
# **Five verbs, and every one of them re-runs every gate.**
#
#   plan      compute and print; write the release notes out. Touches nothing.
#   image     build one platform and push it **by digest**, claiming no tag.
#   manifest  merge the digests into the tags that people type.
#   app       build the native app for one target and name the artifact it
#             produced. A **sibling** of `image`, not a successor: an app
#             artifact has no merge step, so a verb between this and `publish`
#             would decide nothing.
#   publish   create the GitHub Release from the notes `plan` extracted, with
#             every app artifact and the installer on it.
#
# The verbs exist so each `run:` line in the workflow is one word. The gates
# repeat because a workflow is a graph somebody can re-run a single job of, and
# `manifest` executing against a tag that `plan` would have refused is precisely
# the failure that shape invites. Repeating them costs milliseconds.
#
# **What a green run here does not earn.** Nothing about GHCR actually accepting
# the push, nothing about whether the image would start, and nothing about the
# attestation verifying afterwards. Those need the world; this needs a tree.
set -eu

# ---------------------------------------------------------------------------
# The seams, and what each verb needs.
# ---------------------------------------------------------------------------

GH=${GH:-gh}
DOCKER=${DOCKER:-docker}

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE_ROOT=${RELEASE_ROOT:-$(dirname -- "$_here")}

# The published name, and the reason it is nested rather than flat. GHCR takes
# `owner/name` and `owner/repo/name` alike; the second is chosen so the published
# reference and the locally-built one are visibly the same artifact —
# `reemoat/control-plane:current` beside
# `ghcr.io/rends-east/reemoat/control-plane:v0.1.0`. `REEMOAT_CP_IMAGE` is one
# string either way, which is the whole point of that variable.
RELEASE_IMAGE=${RELEASE_IMAGE:-ghcr.io/rends-east/reemoat/control-plane}

# The architectures this release is published for, and the one variable that
# decides them — the way `REEMOAT_CP_IMAGE` is the one variable that decides
# built-here against pulled-from-a-registry.
#
# `linux/amd64` alone, deliberately. arm64 is *viable*: the lockfile carries
# `@esbuild/linux-arm64` and the glibc rollup binary, the base image is
# `node:24-slim`, and public repositories get native arm64 runners. It is not
# *measured*: `check.yml`'s image job runs on `ubuntu-latest`, so `imagecheck` has
# never built, started or probed this image on arm64, and publishing a manifest
# entry no check has ever exercised would make the first arm64 build in this
# project's history happen on the release path and the first arm64 *run* happen on
# somebody's server. The Dockerfile makes the same argument against alpine in more
# words. Earning it is two edits here and one matrix entry in `check.yml`.
#
# QEMU is refused outright rather than deferred: `pnpm install`, esbuild and vite
# under emulation is the ten-to-forty-times case, on a job already budgeted in
# minutes.
RELEASE_PLATFORMS=${RELEASE_PLATFORMS:-linux/amd64}
RELEASE_PLATFORM=${RELEASE_PLATFORM:-$RELEASE_PLATFORMS}

RELEASE_LATEST=${RELEASE_LATEST:-1}

# The app targets this release is published for, and the one variable that
# decides them — `RELEASE_PLATFORMS`' shape, and its argument word for word.
#
# ⚠ **Every name here must already be built by a job in `check.yml`.** Publishing
# a target no check has ever compiled would make its first build in this project's
# history happen on the release path and its first *run* happen on somebody's
# laptop, with no way to tell a bundler regression from a bug. `deploycheck` reads
# `check.yml`'s matrix and this list against each other, so "add a platform" is
# two edits or it is none.
#
# `macos-x64` rather than `universal-apple-darwin`: `tauri-build`'s `copy_binaries`
# resolves `binaries/node-<target-triple>`, so a universal build wants a `lipo`-ed
# Node *and* both esbuild platform binaries inside the payload. Neither has been
# measured here, and two arch-specific artifacts cover the same hardware with
# nothing unmeasured on the path.
# ⚠ **`-` rather than `:-`, and it is the only knob in this file spelled that
# way.** For every other one an empty value is meaningless — `RELEASE_IMAGE=""`
# is not a request — so `:-` reads "unset or empty means the default" and costs
# nothing. For a *list* an empty value is a request: publish no app at all, which
# is what a control-plane-only patch release wants and what the driver needs in
# order to exercise the notes and the installer without seven artifacts. With
# `:-` there is no way to say it.
# ⚠ **A target joins this list in the same change that gives it a `check.yml`
# leg, never before**, and `deploycheck` asserts that pairing by reading the two
# files against each other. The four below arrived together with `check.yml`'s
# `native` matrix, which builds each of them — a real bundle rather than the
# `--no-bundle` link check that job used to be, because a weaker build standing
# behind a published artifact is the thing this rule exists to stop.
#
# `android` is here on the same terms: `android-apk` in `check.yml` assembles a
# signed APK on every push, and the four repository secrets the `app` verb
# refuses by name further down are set. An unsigned APK installs on nothing, and
# a throwaway key can never be replaced on a device that took it — so those
# secrets are the other half of this word, and removing them is how it comes
# back out.
RELEASE_APP_TARGETS=${RELEASE_APP_TARGETS-macos-arm64 macos-x64 linux-x64 windows-x64 android}
RELEASE_APP_TARGET=${RELEASE_APP_TARGET:-}

# The Android release key, base64 in and never written inside the checkout.
#
# Four values because a JKS carries two passwords and they are routinely
# different; each is refused by name, so somebody who set three finds out which.
RELEASE_ANDROID_KEYSTORE=${RELEASE_ANDROID_KEYSTORE:-}
RELEASE_ANDROID_KEYSTORE_PASSWORD=${RELEASE_ANDROID_KEYSTORE_PASSWORD:-}
RELEASE_ANDROID_KEY_ALIAS=${RELEASE_ANDROID_KEY_ALIAS:-}
RELEASE_ANDROID_KEY_PASSWORD=${RELEASE_ANDROID_KEY_PASSWORD:-}

TAURI=${TAURI:-tauri}
NODE=${NODE:-node}

# The Android signature verifier.
#
# ⚠ **`apksigner` is the only thing in this script that can tell a signed APK
# from an unsigned one**, or say which schemes signed it, and it ships inside the
# Android SDK's build-tools rather than on PATH, at a version-numbered path
# nobody should write down here.
# Left unset it is resolved out of the SDK the build already needed; the `app`
# verb refuses rather than skipping the check when it cannot be found, because a
# verification that silently does not run is worse than none — it reads as green.
APKSIGNER=${APKSIGNER:-}

RELEASE_WORK=${RELEASE_WORK:-${RUNNER_TEMP:-/tmp}/reemoat-release}
RELEASE_NOTES_FILE=${RELEASE_NOTES_FILE:-$RELEASE_WORK/notes.md}
RELEASE_DIGEST_DIR=${RELEASE_DIGEST_DIR:-$RELEASE_WORK/digests}
RELEASE_APP_DIR=${RELEASE_APP_DIR:-$RELEASE_WORK/apps}

fail() {
  echo "$@" >&2
  exit 2
}

verb=${1:-}
case "$verb" in
  plan | image | manifest | app | publish) ;;
  "") fail "usage: deploy/ci-release.sh plan|image|manifest|app|publish" ;;
  *) fail "unknown verb \"$verb\". One of: plan, image, manifest, app, publish" ;;
esac

R=$RELEASE_ROOT

# ---------------------------------------------------------------------------
# What must be set, checked before anything reaches a registry or a forge.
#
# The same reasoning as `ci-deploy.sh`: a missing input is a configuration
# mistake and has to read as one, rather than as buildx failing obscurely against
# an image reference ending in a colon.
# ---------------------------------------------------------------------------

missing=""
[ -n "${RELEASE_TAG:-}" ] || missing="$missing RELEASE_TAG"
[ -n "${RELEASE_REF:-}" ] || missing="$missing RELEASE_REF"

if [ -n "$missing" ]; then
  fail "missing:$missing

  RELEASE_TAG  the tag being released, e.g. v0.1.0
  RELEASE_REF  the commit that tag points at

Until they are set, release by hand: git tag v0.1.0 && git push origin v0.1.0,
which is what triggers .github/workflows/release.yml."
fi

# ---------------------------------------------------------------------------
# The tag is a version, and a prerelease is refused by name.
#
# Refused rather than accepted quietly, because accepting one means answering
# three questions nobody has answered: whether `latest` moves for it, whether the
# GitHub Release is marked prerelease, and what shape `CHANGELOG.md` takes for a
# version that is not final. A refusal that says so is how the next person finds
# out the decision is theirs to make.
# ---------------------------------------------------------------------------

VERSION=${RELEASE_TAG#v}

case "$RELEASE_TAG" in
  v*.*.*-*)
    fail "refusing \"$RELEASE_TAG\": prereleases are not published from here.

  Nothing has decided whether a prerelease moves \`latest\`, whether the release
  is flagged on GitHub, or what CHANGELOG.md's heading looks like for one. All
  three are cheap; none is guessable from this script."
    ;;
esac

case "$RELEASE_TAG" in
  v*) ;;
  # Named as a shape rather than as "add a v", which read as `vnightly` when the
  # rest of the tag was not a version either.
  *) fail "refusing \"$RELEASE_TAG\": a release tag is v<major>.<minor>.<patch>, e.g. v0.1.0" ;;
esac

case "$VERSION" in
  *[!0-9.]* | "" | *..* | .* | *.)
    fail "refusing \"$RELEASE_TAG\": \"$VERSION\" is not a version" ;;
esac

# Three parts exactly, which the pattern above cannot say on its own.
if [ "$(printf '%s' "$VERSION" | tr -cd '.' | wc -c | tr -d ' ')" != "2" ]; then
  fail "refusing \"$RELEASE_TAG\": \"$VERSION\" is not major.minor.patch"
fi

# ---------------------------------------------------------------------------
# The tag against every place the version is written down.
#
# Six files, six comparisons, and each refusal names its own file — because
# "the version disagrees" is not actionable and "packages/web/package.json says
# 0.1.0" is.
#
# `pnpm pincheck` already asserts all of these agree with each other, so in a
# green tree this whole section reduces to one comparison. It is done in full
# anyway, for one reason: `RELEASE_SKIP_CHECK_GATE=1` exists, and with it the
# `pincheck` that would have caught the disagreement never runs. The one thing a
# release must never do is ship an image whose section 13 source offer names a
# version whose source nobody can fetch.
#
# Read with `sed` rather than `node`. A `ci-*` script depends on nothing but a
# shell — `deploy/lib.sh`'s `json_field` does use node and is deliberately not
# reachable from here.
# ---------------------------------------------------------------------------

manifest_version() {
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1
}

# An empty read is a pattern that stopped matching, and it has to fail as loudly
# as a disagreement — a check that silently compares "" to "" is the one outcome
# worse than no check. Same rule `pincheck`'s `capture` states in TypeScript.
require_read() {
  [ -n "$2" ] || fail "refusing $RELEASE_TAG: could not read a version out of $1.

  The file is there and the pattern found nothing, which means it was reformatted.
  Fix the pattern in deploy/ci-release.sh rather than the file."
}

agree() {
  require_read "$1" "$2"
  [ "$2" = "$VERSION" ] || fail "refusing $RELEASE_TAG: $1 says \"$2\", the tag says \"$VERSION\".

  Bump every place the version is written and commit that before tagging.
  \`pnpm pincheck\` is what tells you whether you got all of them."
}

agree "package.json" "$(manifest_version "$R/package.json")"
agree "packages/web/package.json" "$(manifest_version "$R/packages/web/package.json")"
agree "packages/control-plane/package.json" "$(manifest_version "$R/packages/control-plane/package.json")"

offer_version=$(sed -n 's/^const VERSION = "\([^"]*\)";$/\1/p' "$R/packages/control-plane/src/app.ts")
agree "packages/control-plane/src/app.ts" "$offer_version"

changelog_version=$(sed -n 's/^## \[\([0-9][0-9.]*\)\] - .*/\1/p' "$R/CHANGELOG.md" | head -1)
agree "CHANGELOG.md" "$changelog_version"

# And the daemon's own literal, which is the sixth and was checked here by
# nothing.
#
# The paragraph above is the whole argument for it: `pincheck` asserts this one
# too, and `RELEASE_SKIP_CHECK_GATE=1` is exactly the case where `pincheck` never
# runs. What ships wrong then is the number a machine reports about itself, which
# `cpctl admin fleet` reads back and a staged rollout is planned from — and a
# fleet inventory that reports the wrong version is worse than no inventory,
# because "nothing is below v2 any more" is the sentence that decides whether the
# floor can be raised.
daemon_version=$(sed -n 's/^export const DAEMON_VERSION = "\([^"]*\)";$/\1/p' "$R/src/version.ts")
agree "src/version.ts" "$daemon_version"

# ---------------------------------------------------------------------------
# The release notes, which are a thing somebody wrote.
#
# Extracted from the heading to the next one, so `publish` never reaches for
# `--generate-notes`. An empty section is refused: a release nobody can read is
# worse than a release that failed to publish, because only one of the two gets
# noticed.
# ---------------------------------------------------------------------------

#
# It stops at the next `##` **or at the link-reference block**, and the second
# half was measured rather than anticipated: the newest release is the last
# section in the file, so there is no following heading to stop at and the first
# extraction ran to end-of-file and swallowed
# `[Unreleased]: https://…/compare/…` — publishing a release whose notes end in
# two dangling link definitions. Every changelog in this format has that block and
# it is always last, so it is a terminator in its own right.
#
# The trailing pipeline trims blank lines off both ends, so the notes begin and
# end with prose whatever spacing the file uses around headings.
extract_notes() {
  awk -v head="## [$VERSION] " '
    index($0, head) == 1 { inside = 1; next }
    inside && /^## / { exit }
    inside && /^\[[^]]+\]:[ \t]/ { exit }
    inside { print }
  ' "$R/CHANGELOG.md" | sed -e '/./,$!d' | awk '{ lines[NR] = $0 } END { last = 0; for (i = 1; i <= NR; i++) if (lines[i] ~ /[^ \t]/) last = i; for (i = 1; i <= last; i++) print lines[i] }'
}

notes=$(extract_notes)
[ -n "$notes" ] || fail "refusing $RELEASE_TAG: CHANGELOG.md's section for $VERSION is empty.

  The GitHub Release is that section and nothing else. Write it before tagging."

# ---------------------------------------------------------------------------
# Refuse a commit whose checks are not green — and **wait** for one still running.
#
# The same gate `ci-deploy.sh` applies, with one thing true here that is not true
# there: the `check` *workflow* is green only when the `check` job and the `image`
# job both are. So this gate is strictly stronger than a deploy's — the image
# about to be pushed is the one `imagecheck` already built and started.
#
# ⚠ **It used to read the verdict once, and that made the gate a race this
# workflow loses by default.** The old query filtered to `status == "completed"`
# and collapsed everything else through `// "none"`, so a `check` run that was
# still *in flight* was indistinguishable from a commit that had never been
# checked at all — and both refused. But `release.yml` triggers on the tag push,
# and `check.yml` triggers on the very same push, so the two start in the same
# second and this gate runs ~15s later against a run that takes ~2m10s. The gate
# was therefore only ever passing because somebody had pushed the branch minutes
# *earlier*, leaving a completed run on the same commit for it to find.
#
# Measured on this repository. v0.8.0: branch pushed 21:44:03, its `check`
# finished 21:46:05, the tag pushed 21:48:46 — 2m41s of slack, gate green.
# v0.9.0: branch pushed 12:22:35, tag pushed 12:22:37, gate read at 12:22:51 with
# both runs still going — `"none"`, and the release refused. Two seconds apart is
# the ordinary way to push a branch and its tag; the 2m41s was luck, and nothing
# anywhere asked for it. The refusal even said *"Wait for it"*, to a person who
# had already walked away.
#
# So `pending` is now its own verdict and it is waited on, bounded by
# `RELEASE_CHECK_WAIT_SECONDS` (default 2700, under `release.yml`'s
# `timeout-minutes: 45`, so the deadline is this script's sentence rather than a
# runner kill with no explanation).
#
# ⚠ **The number is a multiple of the SLOWEST leg, not of the fastest.** It was
# 420 — "three times a `check` run" — written when `check` was five quick jobs.
# `check` now carries `native-android` and `android-apk`, which run an NDK
# toolchain and a full Gradle assemble, so 420 would refuse an ordinary tag
# *after* the image and manifest jobs had already pushed: the half-done release
# state `publish`-is-last exists to prevent, arriving through the gate instead.
# A leg added to `check` moves this number in the same change.
#
# ⚠ **`none` is deliberately NOT waited on.** A commit with no `check` run at all
# is the shape a missing `actions: read` produces — `release.yml` says so at the
# `plan` job — and that is a permissions bug which must stay loud and instant
# rather than hiding behind a seven-minute wait. Run rows exist the moment the
# event dispatches, so there is no registration lag for this to paper over: at
# 12:22:51 above, both runs already existed and were merely unfinished.
#
# `RELEASE_SKIP_CHECK_GATE=1` is the escape, and it is deliberately awkward.
# ---------------------------------------------------------------------------

if [ "${RELEASE_SKIP_CHECK_GATE:-0}" = "1" ]; then
  echo "check gate skipped by RELEASE_SKIP_CHECK_GATE"
else
  # Both injectable so `deploycheck` can drive the wait, the deadline and the
  # green-after-pending path in milliseconds. A wait of 0 is the old read-once
  # behaviour exactly, which is how the driver asserts what that used to cost.
  check_wait=${RELEASE_CHECK_WAIT_SECONDS:-2700}
  check_poll=${RELEASE_CHECK_POLL_SECONDS:-15}
  waited=0
  while :; do
    verdict=$("$GH" run list --workflow check --commit "$RELEASE_REF" \
      --json conclusion,status --limit 20 \
      --jq 'if length == 0 then "none"
            elif any(.[]; .status == "completed")
            then ([.[] | select(.status == "completed")] | first | .conclusion // "unknown")
            else "pending" end' 2>/dev/null || echo "unknown")
    [ "$verdict" = "pending" ] || break
    if [ "$waited" -ge "$check_wait" ]; then
      verdict="timeout"
      break
    fi
    echo "check for $RELEASE_REF: still running, ${waited}s of ${check_wait}s"
    sleep "$check_poll"
    waited=$((waited + check_poll))
  done
  echo "check for $RELEASE_REF: $verdict"
  if [ "$verdict" = "timeout" ]; then
    fail "refusing to release $RELEASE_REF: its \`check\` run was still going after ${check_wait}s.

  Something is stuck, or a check got slower than this gate expects. Look at it,
  then re-run this job — the tag and the commit do not move.
  RELEASE_CHECK_WAIT_SECONDS raises the bound."
  fi
  if [ "$verdict" != "success" ]; then
    fail "refusing to release $RELEASE_REF: its \`check\` run is \"$verdict\".

  Wait for it, or fix it. If you mean to go around it, say so out loud:
  RELEASE_SKIP_CHECK_GATE=1"
  fi
fi

# ---------------------------------------------------------------------------
# Refuse a re-release.
#
# Two questions, and the second is the one that matters. GitHub refuses to create
# a release that exists; **GHCR moves a tag without complaining**, so publishing
# v0.1.0 twice silently repoints a name somebody has already pulled and pinned. A
# registry that overwrites quietly is why this asks rather than relies on the
# forge to refuse.
# ---------------------------------------------------------------------------

if [ "${RELEASE_ALLOW_RETAG:-0}" = "1" ]; then
  echo "existing-release check skipped by RELEASE_ALLOW_RETAG"
else
  if "$GH" release view "$RELEASE_TAG" >/dev/null 2>&1; then
    fail "refusing $RELEASE_TAG: a GitHub Release for it already exists.

  Releases are not edited in place here. Cut the next version, or say so out
  loud: RELEASE_ALLOW_RETAG=1"
  fi
  # ⚠ The image half is asked by every verb **except `publish`**, and that is
  # ordering rather than a softer rule. `manifest` runs immediately before it and
  # creates exactly the tag this looks for, so asking here would make the last
  # step of a successful release refuse the release it just built — a gate that
  # fires only when everything worked. `plan` runs first and asks in full, which
  # is where a genuine re-release is caught.
  if [ "$verb" != "publish" ] && "$DOCKER" buildx imagetools inspect "$RELEASE_IMAGE:$RELEASE_TAG" >/dev/null 2>&1; then
    fail "refusing $RELEASE_TAG: $RELEASE_IMAGE:$RELEASE_TAG is already published.

  Somebody may have pulled it. Moving a tag under them is the one thing a
  release must not do. Cut the next version, or say so out loud:
  RELEASE_ALLOW_RETAG=1"
  fi
fi

# ---------------------------------------------------------------------------
# What gets published, computed from files rather than written down here.
#
# Every label below is derived. A `LABEL org.opencontainers.image.licenses=` line
# in the Dockerfile would be a third place this project's licence is recorded,
# beside `package.json` and `LICENSE`, and the third copy is the one that goes
# stale.
#
# `source` is read from `app.ts`'s `SOURCE_URL` rather than from
# `package.json`'s `repository.url`, which is the more load-bearing of two
# strings that are equal today. GHCR uses that label to link the package to a
# repository, and `app.ts` instructs a fork to change that constant to satisfy
# section 13 — so a fork that follows the licence instruction gets a correct
# image label as a side effect. `pincheck` keeps the two in step here.
# ---------------------------------------------------------------------------

json_field() {
  sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}

source_url=$(sed -n 's/^const SOURCE_URL = "\([^"]*\)";$/\1/p' "$R/packages/control-plane/src/app.ts")
require_read "packages/control-plane/src/app.ts (SOURCE_URL)" "$source_url"

# Each guarded, for `require_read`'s own stated reason: an empty read is a
# pattern that stopped matching and has to fail as loudly as a disagreement. Only
# `source_url` was, and the other four go straight into a `--label` — so
# reformatting `package.json`, or making `author` an object, published an image
# with an empty licence or vendor and a green run everywhere. `deploycheck`'s
# `labelFollows` asserts the populated case and cannot see the empty one.
license=$(json_field "$R/package.json" license)
require_read "package.json (license)" "$license"
homepage=$(json_field "$R/package.json" homepage)
require_read "package.json (homepage)" "$homepage"
vendor=$(json_field "$R/package.json" author)
require_read "package.json (author)" "$vendor"
description=$(json_field "$R/packages/control-plane/package.json" description)
require_read "packages/control-plane/package.json (description)" "$description"
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
short_sha=$(printf '%s' "$RELEASE_REF" | cut -c1-12)

# Three tags, and two that were considered and dropped.
#
#   v0.1.0     the git tag verbatim, so what an operator pastes is what `git tag`
#              says.
#   sha-<12>   the only tag stable by construction, and the one a rollback wants.
#   latest     the quick-start line needs something to type. It moves, and the
#              README says it moves.
#
# Dropped: a bare `0.1.0`, because two names for one digest is two things to keep
# in step for no gain; and rolling `0.1` and `0`, because under SemVer a 0.x
# *minor* is the breaking one, so `:0` here would mean "may break without
# warning" while reading like stability.
tag_version="$RELEASE_IMAGE:$RELEASE_TAG"
tag_sha="$RELEASE_IMAGE:sha-$short_sha"
tag_latest=""
[ "$RELEASE_LATEST" = "1" ] && tag_latest="$RELEASE_IMAGE:latest"

emit() {
  echo "$1=$2"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"
  return 0
}

# ---------------------------------------------------------------------------
# The app targets, as a table rather than as branching.
#
# Four questions per target and each has exactly one answer here: which Rust
# triple it builds for, whether it carries a daemon payload, what artifact falls
# out with what name, and which runner builds it.
#
# The fourth arrived with the workflow wiring and is the reason the other three
# stayed here rather than half-migrating into YAML: `plan` emits this table as
# `release.yml`'s matrix, so the workflow holds no list of its own and adding a
# target is `RELEASE_APP_TARGETS` plus a `check.yml` leg — never a third edit.
#
# ⚠ **What it deliberately does *not* answer is which bundle kinds to produce.**
# That is `bundle.targets` in `packages/native/src-tauri/tauri.<platform>.conf.json`,
# and passing `--bundles` here would be a second copy of it — two places to keep
# in step, with the silent direction being a release that publishes a `.deb` while
# the checked-in configuration says AppImage. So the build below carries no
# `--bundles` at all and `deploycheck` asserts its absence.
#
# The product name is **read** rather than written, the way every OCI label
# already is: a fork that renames the app gets correctly-named assets without
# editing this script.
# ---------------------------------------------------------------------------

app_product=$(json_field "$R/packages/native/src-tauri/tauri.conf.json" productName)
require_read "packages/native/src-tauri/tauri.conf.json (productName)" "$app_product"

# Every target this script can build, which is a wider list than
# `RELEASE_APP_TARGETS`: the first is what the table knows how to do, the second
# is what this release publishes. Naming both is how "unknown target" and "known
# target you did not ask for" stay two different refusals.
app_known="macos-arm64 macos-x64 linux-x64 linux-arm64 windows-x64 android"

app_triple() {
  case "$1" in
    macos-arm64) echo "aarch64-apple-darwin" ;;
    macos-x64) echo "x86_64-apple-darwin" ;;
    linux-x64) echo "x86_64-unknown-linux-gnu" ;;
    linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
    windows-x64) echo "x86_64-pc-windows-msvc" ;;
    # Four ABIs in one universal APK, so there is no single triple to name and
    # the arch token is absent from the asset name for the same reason.
    android) echo "" ;;
    *) return 1 ;;
  esac
}

# `full` carries the Node runtime and a copy of `src/`; `client` carries neither.
# `.claude/rules/native-packaging.md` owns the argument and the per-platform
# answer; this reads it back rather than restating it, by asking the one thing
# that decides it — whether that platform has an overlay taking the payload away.
app_profile() {
  _overlay=""
  case "$1" in
    macos-*) _overlay="" ;;
    linux-*) _overlay="tauri.linux.conf.json" ;;
    windows-*) _overlay="tauri.windows.conf.json" ;;
    android) _overlay="tauri.android.conf.json" ;;
    *) return 1 ;;
  esac
  if [ -z "$_overlay" ]; then
    echo "full"
  elif grep -q '"externalBin": *null' "$R/packages/native/src-tauri/$_overlay" 2>/dev/null; then
    echo "client"
  else
    fail "refusing $RELEASE_TAG: $_overlay does not take the daemon payload away.

  Every platform but macOS ships a client build, and the overlay is where that is
  said. Either it carries \"externalBin\": null and \"resources\": null, or this
  target is a daemon host and the table in deploy/ci-release.sh is out of date
  with .claude/rules/native-packaging.md."
  fi
}

# And which runner builds it, which is the fourth question and the one this file
# had no answer for at all.
#
# ⚠ **It is here rather than in `release.yml`'s matrix for the reason every other
# row is here: a matrix written out in YAML is a third list to keep in step with
# `RELEASE_APP_TARGETS` and with `check.yml`, and the only one of the three that
# nothing can drive.** `plan` emits this table as the matrix, so `deploycheck`
# reads JSON a fixture produced rather than grepping a workflow for a leg
# somebody hand-wrote — and "add a target" stays two edits or it is none.
#
# Both macOS targets answer the same arm64 runner, which is the row worth stating
# because it is the one that is not obvious. `tauri build --target
# x86_64-apple-darwin` cross-compiles there, and `build-daemon.mjs`'s `TARGETS`
# already carries the x64 Node build and `@esbuild/darwin-x64` beside the arm64
# pair — so there is nothing unmeasured about the payload either. GitHub's
# Intel-macOS label has moved once already; a second runner would be a second
# thing to re-check every time it moves again.
#
# ⚠ **There is deliberately no `android` arm, and its absence is what keeps
# android out of the matrix.** An APK needs a JDK, the SDK, the NDK and a Gradle
# run, and it is the only target that reads a signing key — so it is
# `app-android`, a job of its own, and `plan` announces it with a flag instead. A
# row here would be a value with no reader, which is the objection
# `native-packaging.md` already makes to `bundle.targets` on a mobile overlay.
#
# The `*)` arm is reachable by drift rather than by typo: `app_check_targets` has
# already refused a name the table does not know, so what lands there is a target
# somebody added to `app_triple` and `app_artifacts` and not to this.
app_runner() {
  case "$1" in
    macos-arm64 | macos-x64) echo "macos-latest" ;;
    linux-x64) echo "ubuntu-latest" ;;
    linux-arm64) echo "ubuntu-24.04-arm" ;;
    windows-x64) echo "windows-latest" ;;
    *) return 1 ;;
  esac
}

# One line per artifact, as `<glob>|<how>|<asset name>`. `zipdir` is for a macOS
# `.app`, which is a *directory* — `ditto -c -k --keepParent` rather than `zip
# -r`, because a plain zip flattens the framework symlinks inside a bundle and
# produces something that will not launch.
app_artifacts() {
  _t=$(app_triple "$1") || return 1
  _b="packages/native/src-tauri/target/$_t/release/bundle"
  case "$1" in
    macos-*)
      echo "$_b/macos/*.app|zipdir|$app_product-$VERSION-$1.app.zip" ;;
    linux-*)
      echo "$_b/deb/*.deb|copy|$app_product-$VERSION-$1.deb"
      echo "$_b/appimage/*.AppImage|copy|$app_product-$VERSION-$1.AppImage" ;;
    windows-*)
      echo "$_b/nsis/*-setup.exe|copy|$app_product-$VERSION-$1-setup.exe" ;;
    # ⚠ **Named exactly, never `*.apk`, and the reason is one filename.** AGP
    # writes `app-universal-release-unsigned.apk` when the release build type
    # carries no `signingConfig` — which is what happens when
    # `System.getenv("ANDROID_KEYSTORE_PATH")` answers null inside the Gradle
    # **daemon**, a JVM that outlives one build and captured its environment when
    # it started. A `*.apk` glob matched that name exactly as well as the signed
    # one and matched exactly one file, so the collision gate saw nothing wrong
    # and the release would have carried an APK that installs on no device, under
    # the signed one's asset name. Naming the file is the cheap half; the
    # `apksigner` run in the `app` verb is what catches an APK at the right name
    # whose signature does not verify.
    android)
      echo "packages/native/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk|copy|$app_product-$VERSION-android.apk" ;;
    *) return 1 ;;
  esac
}

# Every asset name this release is going to carry, in one place, so `plan` can
# refuse a collision before a single runner starts and `publish` can name the one
# that is missing rather than saying "something".
# ⚠ **Every name in the list is checked against the table before anything uses
# it, and the loop below is why.** `app_artifacts` answers 1 for a name the table
# does not know, and it is called *inside a pipeline* — there is no `pipefail`
# here, so `set -e` never sees it and the name contributes no asset at all.
# A typo therefore used to pass `plan`'s collision gate and `publish`'s
# completeness gate alike, and the release went out with that platform simply
# absent: the exact outcome `publish`'s own refusal says cannot happen. The
# `app` verb refuses an unknown *singular* target, but a typo'd list never
# reaches it, because no matrix leg runs for a name nobody wrote a job for.
app_check_targets() {
  for _target in $RELEASE_APP_TARGETS; do
    app_triple "$_target" >/dev/null 2>&1 || fail \
      "refusing $RELEASE_TAG: RELEASE_APP_TARGETS names \"$_target\", which is not a target this release knows.

  One of: $app_known

  A name the table does not know contributes no artifact and no asset name, so
  every gate below would pass and the release would be published without it."
  done
}

# ⚠ **`app_check_targets` is deliberately NOT called from here.** Both call sites
# below invoke this function inside `$( )`, and `fail` in a command substitution
# exits the *subshell*: the refusal prints on stderr, `$?` stays 0 and the release
# carries on. Measured. So the check is called by each verb directly.
app_asset_names() {
  for _target in $RELEASE_APP_TARGETS; do
    app_artifacts "$_target" | while IFS='|' read -r _glob _how _name; do
      echo "$_name"
    done
  done
}

# ---------------------------------------------------------------------------
# The verbs.
# ---------------------------------------------------------------------------

case "$verb" in

  plan)
    # ── what every app leg is going to be asked for, before any of them runs ──
    #
    # Both of these are cheap, both run first, and both exist because the
    # alternative is discovering them in the fortieth minute of a matrix.
    #
    # A collision is a table edit rather than a build failure: two targets
    # computing one asset name would have one silently win, and
    # `releases/latest/download/<name>` resolves on that name.
    app_check_targets
    app_seen=""
    for app_name in $(app_asset_names); do
      case " $app_seen " in
        *" $app_name "*) fail "refusing $RELEASE_TAG: two targets both produce $app_name.

  GitHub resolves releases/latest/download/<name> on the asset name, so one would
  win and the other would be a download nobody can reach. Fix app_artifacts() in
  deploy/ci-release.sh." ;;
      esac
      app_seen="$app_seen $app_name"
    done

    # ⚠ **The Android key is deliberately *not* asked for here, and the first
    # version of this did ask.** It looked like the same cheap gate as the one
    # above: refuse early rather than after forty minutes of matrix. It is not.
    # The four secrets are scoped to the `app-android` job precisely so that *who
    # can read the keystore* is answerable by reading `release.yml` — and `plan`
    # is the job whose whole property is that it "can write nothing anywhere".
    # Asking here would mean handing the signing key to the job that runs every
    # gate, or refusing every release for want of a secret this job cannot see.
    #
    # And the saving was imaginary: `app` and `app-android` are siblings under
    # `plan`, so they start in the same second. A missing secret is found at the
    # same moment every other leg begins, not forty minutes later. The `app` verb
    # names all four, one at a time.

    mkdir -p "$RELEASE_WORK"
    printf '%s\n' "$notes" > "$RELEASE_NOTES_FILE"
    # ── AGPL §6, which `bundle.licenseFile` does not discharge ─────────────
    #
    # ⚠ **Handing somebody a binary is a *distribution*, and §13's source offer is
    # about the hosted service.** `docs/NATIVE.md` names the gap; what it does not
    # name is that `bundle.licenseFile` closes it only for the bundlers that read
    # one — `dmg` and `nsis` — and the macOS artifact is a `.app`, which reads it
    # for nothing. So the offer rides the release page, where every artifact is.
    #
    # It names *this tag* rather than a branch: `main` is routinely ahead of every
    # tag, so "the corresponding source" has to be the commit that was built.
    # `source_url` is `app.ts`'s `SOURCE_URL` — the same constant §13 uses and the
    # one a fork is instructed to change — so a fork gets a correct offer for free.
    printf '\n---\n\nThese builds are AGPL-3.0-only, and conveying a binary is a distribution.\nThe corresponding source for this release is the `Source code` archive on this\npage and %s/tree/%s.\n' \
      "$source_url" "$RELEASE_TAG" >> "$RELEASE_NOTES_FILE"
    # ── the matrix `release.yml` runs, computed here rather than written there ──
    #
    # ⚠ **Three outputs for one list, and the shape of each is decided by what
    # reads it.** `app_targets` is the word list a person reads in the log and
    # what `publish`'s download step is gated on. `app_matrix` is the same thing
    # as JSON, in the `{"include": […]}` form a matrix takes directly.
    # `app_desktop` and `app_android` are what the two jobs' `if:` lines compare
    # — and they exist because **an empty matrix in GitHub Actions is a job that
    # fails rather than one that skips**, so "no targets today" has to be sayable
    # to an `if:` before the matrix is ever evaluated.
    #
    # `app_desktop` is not `app_targets`: a release asking for android alone has
    # a non-empty target list and an empty matrix, which is precisely the case
    # that would have failed.
    #
    # Built by hand rather than with `jq`, for the reason the header gives: a
    # `ci-*` script depends on nothing but a shell. Every value interpolated is a
    # target name out of a closed table, so there is nothing here to escape.
    app_matrix='{"include":['
    app_desktop=""
    app_android=""
    _first=1
    for app_target in $RELEASE_APP_TARGETS; do
      if [ "$app_target" = "android" ]; then
        app_android="1"
        continue
      fi
      app_target_runner=$(app_runner "$app_target") || fail \
        "refusing $RELEASE_TAG: $app_target has no runner in app_runner().

  It is a known target — app_triple() and app_artifacts() both answer for it — so
  this is one table extended in three places and not the fourth. A leg with no
  runner is a matrix entry GitHub cannot schedule, which fails the whole run
  before a single gate above has been read."
      [ "$_first" = "1" ] || app_matrix="$app_matrix,"
      _first=0
      app_matrix="$app_matrix{\"target\":\"$app_target\",\"triple\":\"$(app_triple "$app_target")\",\"runner\":\"$app_target_runner\"}"
      app_desktop="${app_desktop:+$app_desktop }$app_target"
    done
    app_matrix="$app_matrix]}"

    emit app_targets "$RELEASE_APP_TARGETS"
    emit app_matrix "$app_matrix"
    emit app_desktop "$app_desktop"
    emit app_android "$app_android"
    emit version "$VERSION"
    emit tag "$RELEASE_TAG"
    emit image "$RELEASE_IMAGE"
    emit platforms "$RELEASE_PLATFORMS"
    emit tag_version "$tag_version"
    emit tag_sha "$tag_sha"
    emit tag_latest "$tag_latest"
    emit source "$source_url"
    emit notes_file "$RELEASE_NOTES_FILE"
    echo "notes: $(printf '%s\n' "$notes" | wc -l | tr -d ' ') lines from CHANGELOG.md for $VERSION"
    ;;

  image)
    mkdir -p "$RELEASE_DIGEST_DIR"
    meta="$RELEASE_WORK/metadata-$(printf '%s' "$RELEASE_PLATFORM" | tr '/' '-').json"
    mkdir -p "$RELEASE_WORK"

    # Labels first, into the positional parameters, because a description carries
    # spaces and a word-split list of `--label` arguments would quietly truncate
    # it at the first one.
    set --
    set -- "$@" --label "org.opencontainers.image.title=reemoat control plane"
    set -- "$@" --label "org.opencontainers.image.description=$description"
    set -- "$@" --label "org.opencontainers.image.version=$VERSION"
    set -- "$@" --label "org.opencontainers.image.revision=$RELEASE_REF"
    set -- "$@" --label "org.opencontainers.image.created=$created"
    set -- "$@" --label "org.opencontainers.image.source=$source_url"
    set -- "$@" --label "org.opencontainers.image.url=$homepage"
    set -- "$@" --label "org.opencontainers.image.licenses=$license"
    set -- "$@" --label "org.opencontainers.image.documentation=$source_url/blob/$RELEASE_TAG/deploy/README.md"
    set -- "$@" --label "org.opencontainers.image.vendor=$vendor"

    # Pushed **by digest**, claiming no tag at all. Two runners building two
    # architectures must not each write the same tag — the second would win and
    # the release would be single-arch with no error anywhere. `manifest` is what
    # turns digests into names.
    #
    # ⚠ **No `--load` here, and that is not an oversight.** `imagecheck` passes
    # `--load` and explains at length why it must: under the docker-container
    # driver a local build otherwise stays in the buildx cache, the command exits
    # 0, and the next `docker run` reaches for Docker Hub. That reasoning is about
    # a build whose output is the local daemon. This one's output is a registry,
    # and `--load` beside `push` is a contradiction. Copying that flag over is the
    # obvious mistake, so `deploycheck` asserts it is absent.
    echo "building $RELEASE_PLATFORM for $RELEASE_IMAGE at $RELEASE_TAG"
    "$DOCKER" buildx build \
      --platform "$RELEASE_PLATFORM" \
      --file "$R/deploy/docker/Dockerfile" \
      "$@" \
      --provenance=false \
      --output "type=image,name=$RELEASE_IMAGE,push-by-digest=true,name-canonical=true,push=true" \
      --metadata-file "$meta" \
      "$R"

    # Two failures, and they are not the same failure — which is why they do not
    # share `require_read`'s wording about a reformatted file. No metadata at all
    # means the build did not run or did not get far enough to write it; metadata
    # with no digest in it means buildx changed the key.
    [ -f "$meta" ] || fail "refusing $RELEASE_TAG: the build wrote no metadata at $meta.

  buildx writes that file at the end of a successful build, so its absence means
  the build did not finish."

    digest=$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$meta" | head -1)
    [ -n "$digest" ] || fail "refusing $RELEASE_TAG: $meta carries no containerimage.digest.

  The build finished and buildx reported no digest under that key, which means
  the key moved. Fix the pattern in deploy/ci-release.sh."
    printf '%s\n' "$digest" > "$RELEASE_DIGEST_DIR/$(printf '%s' "$RELEASE_PLATFORM" | tr '/' '-')"
    echo "digest: $RELEASE_PLATFORM $digest"
    ;;

  manifest)
    # Every digest `image` wrote, merged into the tags people type. The same
    # command for one digest as for two, which is the whole reason arm64 later is
    # a matrix entry rather than a rewrite of this script.
    [ -d "$RELEASE_DIGEST_DIR" ] || fail "refusing $RELEASE_TAG: no digests at $RELEASE_DIGEST_DIR."

    set --
    set -- "$@" --tag "$tag_version" --tag "$tag_sha"
    [ -n "$tag_latest" ] && set -- "$@" --tag "$tag_latest"

    refs=""
    for f in "$RELEASE_DIGEST_DIR"/*; do
      [ -f "$f" ] || continue
      refs="$refs $RELEASE_IMAGE@$(cat "$f")"
    done

    # An empty digest directory is what a silently-skipped matrix leg looks like,
    # and merging nothing would publish a tag that resolves to nothing while
    # every step reported success.
    [ -n "$refs" ] || fail "refusing $RELEASE_TAG: $RELEASE_DIGEST_DIR holds no digests.

  Every \`image\` job was skipped or failed to write one. Publishing the tags now
  would create names that resolve to nothing."

    echo "merging$refs"
    # shellcheck disable=SC2086 -- refs is a list of image references, deliberately split
    "$DOCKER" buildx imagetools create "$@" $refs

    # And the digest of what that produced, emitted rather than left for the
    # workflow to go and ask for. The attestation step needs a subject digest,
    # and "run an inspect and parse it" is a decision — the kind this whole file
    # exists to keep out of YAML. It is the **index** digest, not a platform's:
    # one attestation covering the manifest people actually pull.
    index_digest=$("$DOCKER" buildx imagetools inspect "$tag_version" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true)
    [ -n "$index_digest" ] || fail "refusing $RELEASE_TAG: $tag_version was created and then could not be inspected.

  The tags are published; only the attestation subject is missing. Re-run this
  verb with RELEASE_ALLOW_RETAG=1 rather than rebuilding."
    emit digest "$index_digest"
    emit image "$RELEASE_IMAGE"
    ;;

  app)
    [ -n "$RELEASE_APP_TARGET" ] || fail "refusing $RELEASE_TAG: \`app\` needs RELEASE_APP_TARGET.

  One of: $app_known
  release.yml's \`app\` matrix sets it, out of the JSON \`plan\` emits; nothing here
  guesses a default, because a default would be one platform's build published
  under every other one's name."

    app_triple "$RELEASE_APP_TARGET" >/dev/null 2>&1 || fail \
      "refusing $RELEASE_TAG: \"$RELEASE_APP_TARGET\" is not a target this release knows.

  One of: $app_known

  Adding one is a line in app_triple()/app_artifacts() here **and** a matrix entry
  in check.yml's native job, in that order. Publishing a target no check has ever
  built would make its first build in this project's history happen on the release
  path."

    case " $RELEASE_APP_TARGETS " in
      *" $RELEASE_APP_TARGET "*) ;;
      *) fail "refusing $RELEASE_TAG: $RELEASE_APP_TARGET is a known target and is not in RELEASE_APP_TARGETS.

  A leg building an artifact this release does not publish is a matrix that has
  drifted from the list — which release.yml cannot do on its own any more,
  because plan computes that matrix *from* this list and deploycheck drives the
  computation. What reaches here is a RELEASE_APP_TARGET set by hand: a re-run
  with an edited environment, or this verb run from a checkout. Add the name to
  RELEASE_APP_TARGETS, or do not ask for it." ;;
    esac

    app_target_triple=$(app_triple "$RELEASE_APP_TARGET")
    app_target_profile=$(app_profile "$RELEASE_APP_TARGET")
    mkdir -p "$RELEASE_APP_DIR"

    # ── the payload, or the absence of one ────────────────────────────────
    #
    # ⚠ **The client half is the one with a real failure behind it.** A runner is
    # reused and a matrix leg is re-run, so `binaries/node-*` and `target/daemon`
    # outlive the build that staged them — and `tauri-build` copies whatever it
    # finds, with no configuration saying it should not. The overlay removing
    # `externalBin` is what makes that harmless, so this refuses rather than
    # deleting: a staged runtime on a client leg means the leg is not the one
    # whose name it is running under.
    if [ "$app_target_profile" = "full" ]; then
      echo "staging the daemon payload for $app_target_triple"
      "$NODE" "$R/packages/native/scripts/build-daemon.mjs" "$app_target_triple"
      [ -f "$R/packages/native/src-tauri/target/daemon/scripts/daemon.ts" ] \
        || fail "refusing $RELEASE_TAG: $RELEASE_APP_TARGET is a daemon-host build and nothing was staged.

  build-daemon.mjs reported success and wrote its payload somewhere this cannot
  find. \`pnpm native:stage\` from a checkout is the same command."
    else
      stale=""
      [ -d "$R/packages/native/src-tauri/target/daemon" ] && stale="$stale target/daemon"
      for f in "$R/packages/native/src-tauri/binaries"/node-*; do
        [ -e "$f" ] && stale="$stale binaries/$(basename "$f")"
      done
      [ -z "$stale" ] || fail "refusing $RELEASE_TAG: $RELEASE_APP_TARGET is a client build and a staged runtime is still here:$stale

  A client build carries no Node payload — docs/NATIVE.md's *What runs where* has
  the reason per platform. The bundler copies what it finds, so this is 130 MB
  shipped to people it can never run for. Delete it, or build this target on a
  runner that never staged one."
    fi

    # ── the build ─────────────────────────────────────────────────────────
    #
    # No `--bundles`: the kinds are `bundle.targets`, merged from the platform
    # overlay, and a flag here would be the second copy of that list.
    echo "building $RELEASE_APP_TARGET ($app_target_profile) for $RELEASE_TAG"
    if [ "$RELEASE_APP_TARGET" = "android" ]; then
      android_missing=""
      [ -n "$RELEASE_ANDROID_KEYSTORE" ] || android_missing="$android_missing RELEASE_ANDROID_KEYSTORE"
      [ -n "$RELEASE_ANDROID_KEYSTORE_PASSWORD" ] || android_missing="$android_missing RELEASE_ANDROID_KEYSTORE_PASSWORD"
      [ -n "$RELEASE_ANDROID_KEY_ALIAS" ] || android_missing="$android_missing RELEASE_ANDROID_KEY_ALIAS"
      [ -n "$RELEASE_ANDROID_KEY_PASSWORD" ] || android_missing="$android_missing RELEASE_ANDROID_KEY_PASSWORD"
      [ -z "$android_missing" ] || fail "refusing $RELEASE_TAG: android is being built and$android_missing is unset.

  All four are repository secrets. An unsigned APK installs on nothing, and one
  signed with a throwaway key can never be replaced on a device that took it —
  Android refuses an upgrade whose signer changed."
      # ── the signing key on disk, and the four things writing it out has to
      #    get right ─────────────────────────────────────────────────────────
      #
      # Still outside the checkout, so no `git add` and no artifact upload can
      # carry it — that half of the old comment held, and it was the only half.
      #
      # ⚠ **The directory is made by `mktemp -d`, not named.** The old path was
      # `$RELEASE_WORK/android-release.jks`, and `RELEASE_WORK` falls back to
      # `/tmp/reemoat-release` whenever `RUNNER_TEMP` is unset — which is every
      # run outside GitHub Actions, a maintainer's laptop included. `/tmp` is
      # world-writable, `mkdir -p` succeeds on a directory somebody else already
      # made, and `>` follows a symlink: anybody with a shell on that host could
      # have pre-created `/tmp/reemoat-release/android-release.jks` pointing at a
      # file they can read, and been handed the fleet's release key. `mktemp -d`
      # creates the directory itself, at 0700, under a name nobody can predict,
      # and fails rather than reusing one.
      #
      # ⚠ **And it is deliberately not `$RELEASE_WORK`, which is the parent of
      # `$RELEASE_APP_DIR`** — the directory `publish` uploads assets out of.
      # Nothing globs the parent today. The signing key does not live one `*`
      # away from the upload set on the strength of "nothing globs it today".
      #
      # ⚠ **The trap is armed before anything secret exists, and it used to be
      # armed after the write.** A Ctrl-C or a cancelled job inside that window
      # left the keystore on the runner with no handler to remove it. Arming it
      # against the empty directory means there is no moment in which the key is
      # on disk and unclaimed.
      #
      # ⚠ **`umask 077` around the write, because `>` creates at the umask.** A
      # runner's default is `022`, so the old redirection produced a `0644`
      # keystore. The `mktemp` directory already denies everyone else and this is
      # the second lock rather than the first: a mode is what survives the file
      # being copied somewhere, and a directory's mode is not.
      #
      # `-s` afterwards because `base64 -d` on a truncated or mis-pasted secret
      # writes an empty file and exits 0, and an empty keystore is a Gradle error
      # forty minutes later that reads as a toolchain problem rather than as a
      # bad secret.
      android_key_dir=$(mktemp -d "${TMPDIR:-/tmp}/reemoat-android-key.XXXXXX")
      trap 'rm -rf "$android_key_dir"' EXIT INT TERM
      ANDROID_KEYSTORE_PATH="$android_key_dir/android-release.jks"
      (umask 077 && printf '%s' "$RELEASE_ANDROID_KEYSTORE" | base64 -d > "$ANDROID_KEYSTORE_PATH")
      [ -s "$ANDROID_KEYSTORE_PATH" ] || fail "refusing $RELEASE_TAG: RELEASE_ANDROID_KEYSTORE decoded to nothing.

  The secret is the keystore, base64-encoded. An empty decode means it was pasted
  truncated or in the wrong encoding. Nothing was signed, and nothing was left on
  disk."
      ANDROID_KEYSTORE_PASSWORD=$RELEASE_ANDROID_KEYSTORE_PASSWORD
      ANDROID_KEY_ALIAS=$RELEASE_ANDROID_KEY_ALIAS
      ANDROID_KEY_PASSWORD=$RELEASE_ANDROID_KEY_PASSWORD
      export ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
      (cd "$R/packages/native" && "$TAURI" android build --apk)

      # ── the signature, checked rather than assumed ────────────────────────
      #
      # ⚠ **A release build signs itself only if `System.getenv("ANDROID_KEYSTORE_PATH")`
      # is non-null *inside the Gradle JVM*, and that JVM is a daemon which
      # outlives this script.** `app/build.gradle.kts` reads the variable at
      # configuration time; a Gradle daemon started by an earlier build — a
      # previous matrix leg, a developer's `tauri android dev`, a retry — carries
      # the environment it was started with, so exporting the four names above is
      # not by itself evidence that the build saw any of them. What it produces
      # then is `app-universal-release-unsigned.apk`; what it produces if the
      # keystore is unreadable is a build failure. Both of those are caught now.
      # This covers the third case: an APK at the signed name whose signature does
      # not actually verify.
      #
      # ⚠ **What this proves and what it does not.** `apksigner verify` answers
      # *this APK is signed and the signature is internally consistent for its
      # minSdk*. It does not answer *signed with the release key* — that needs a
      # certificate fingerprint, which is not in this repository and would be a
      # second place the identity of the signing key lives. Android's own refusal
      # to upgrade across a changed signer is the backstop for the wrong key; this
      # is the backstop for **no** key, which is the one with no symptom until
      # somebody tries to install it.
      #
      # The resolver takes the last match, which is the highest build-tools
      # version the shell's glob ordering gives. A miss is a refusal rather than a
      # skip, for the reason the seam's own comment gives.
      if [ -z "$APKSIGNER" ]; then
        for _candidate in "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/nonexistent}}"/build-tools/*/apksigner; do
          if [ -x "$_candidate" ]; then APKSIGNER=$_candidate; fi
        done
      fi
      [ -n "$APKSIGNER" ] || fail "refusing $RELEASE_TAG: no apksigner under \$ANDROID_HOME/build-tools.

  It ships with the Android SDK build-tools, which this build already needed. Set
  APKSIGNER to it, or install that package. Publishing without it would mean
  taking \"the APK is signed\" on the strength of four variables having been
  exported — which is the thing a reused Gradle daemon can silently make untrue."
      android_apk=$R/packages/native/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
      [ -f "$android_apk" ] || fail "refusing $RELEASE_TAG: the build produced no app-universal-release.apk.

  AGP appends -unsigned to a release APK when the release build type carries no
  signingConfig, so look for app-universal-release-unsigned.apk beside it: that is
  a Gradle daemon started before these secrets existed, which configured the build
  without them. \`./gradlew --stop\` first, or build with \`--no-daemon\`."
      "$APKSIGNER" verify "$android_apk" || fail "refusing $RELEASE_TAG: $android_apk is not validly signed.

  The four secrets were exported and the build produced an APK at the signed name,
  so the signature itself is what failed. An APK published like this installs on
  nothing, and the name it would carry is the one people fetch from
  releases/latest/download."

      # ── and signed with v1 as well as v2, which Android does not need ─────
      #
      # ⚠ **The JAR signature is for an installer that is not Android's.** AGP
      # leaves it out by itself at `minSdk` 24, and 0.10.1 shipped that way: it
      # passed the check above, installed on a Pixel and over `adb install` on a
      # OnePlus 13, and that OnePlus's own installer refused it as invalid. That
      # an OEM installer parsing the APK before the platform does wants a JAR
      # signature is the leading hypothesis rather than a measurement;
      # `app/build.gradle.kts` carries the rest beside `enableV1Signing`.
      #
      # ⚠ **`--min-sdk-version 23` is what makes the v1 line mean anything.**
      # `apksigner` consults a JAR signature only below API 24 or when there is
      # no v2-or-newer block — Android 7's own rule, in apksig's `ApkVerifier` —
      # and by default it checks from the manifest's `minSdk`, which is 24. So at
      # the default it prints `v1 scheme (JAR signing): false` about an APK
      # carrying a perfectly good one, and a gate reading that line would refuse
      # every correct release. At 23 the JAR signature is verified and a missing
      # one is an error rather than a skip — apksig's `JAR_SIG_NO_MANIFEST`,
      # which apksigner prints as `ERROR: Missing META-INF/MANIFEST.MF`, never
      # by that name. Not lower: a lower floor also holds the signature to
      # algorithms older platforms lack, which is a question about devices this
      # app does not install on.
      #
      # A second run rather than a flag on the first, so each refusal is about one
      # thing: that one is a signature that does not verify, this one a scheme the
      # build left out. The lines are what is read, never the exit status: a
      # verifier answering 0 without having checked a scheme cannot pass for one
      # that did, and one answering 1 fails closed because its line is missing.
      # They are printed on success too, because which schemes verified is the
      # first thing to read the day an installer refuses an APK again.
      android_schemes=$("$APKSIGNER" verify --verbose --min-sdk-version 23 "$android_apk" 2>&1) || true
      for android_scheme in "v1 scheme (JAR signing)" "v2 scheme (APK Signature Scheme v2)"; do
        case "$android_schemes" in
          *"Verified using $android_scheme: true"*) ;;
          *) fail "refusing $RELEASE_TAG: $android_apk does not verify using the $android_scheme.

  The signature itself verified above, so this is a scheme the build left out
  rather than one that is broken. A release is signed with v1 and v2 both —
  enableV1Signing and enableV2Signing in gen/android/app/build.gradle.kts —
  because 0.10.1, signed with v2 alone, was refused by a OnePlus's own installer
  while Android itself accepted it. apksigner, asked from API 23, said:

$android_schemes" ;;
        esac
      done
      printf '%s\n' "$android_schemes"
    else
      (cd "$R/packages/native" && "$TAURI" build --target "$app_target_triple")
    fi

    # ── what it produced, named ───────────────────────────────────────────
    app_plan_file="$RELEASE_WORK/app-$RELEASE_APP_TARGET.plan"
    app_artifacts "$RELEASE_APP_TARGET" > "$app_plan_file"
    while IFS='|' read -r glob how name; do
      [ -n "$glob" ] || continue
      # shellcheck disable=SC2086 -- a glob is what this is
      set -- $R/$glob
      if [ ! -e "$1" ]; then
        fail "refusing $RELEASE_TAG: nothing at $glob.

  The bundler writes it at the end of a successful build, so its absence means the
  build did not finish — or that its naming moved, in which case fix the pattern
  in deploy/ci-release.sh rather than renaming the file."
      fi
      [ "$#" -eq 1 ] || fail "refusing $RELEASE_TAG: $glob matched $# files.

  Picking the first of several is how a bundle left by a previous run gets
  published under this release's name. Clean the build directory."
      out="$RELEASE_APP_DIR/$name"
      [ ! -e "$out" ] || fail "refusing $RELEASE_TAG: $name is already in $RELEASE_APP_DIR.

  Two artifacts computed one asset name. GitHub resolves
  releases/latest/download/<name> on the asset name, so one would silently win and
  the other would be a download nobody can reach."
      case "$how" in
        zipdir) (cd "$(dirname "$1")" && ditto -c -k --keepParent --sequesterRsrc "$(basename "$1")" "$out") ;;
        copy) cp "$1" "$out" ;;
        *) fail "refusing $RELEASE_TAG: app_artifacts named \"$how\", which is not a way to package one." ;;
      esac
      bytes=$(wc -c < "$out" | tr -d ' ')
      [ "$bytes" -gt 0 ] || fail "refusing $RELEASE_TAG: $name is empty.

  The bundler exited 0 having written nothing this could package."
      echo "app: $RELEASE_APP_TARGET $name $bytes bytes"
    done < "$app_plan_file"
    ;;

  publish)
    [ -f "$RELEASE_NOTES_FILE" ] || fail "refusing $RELEASE_TAG: no notes at $RELEASE_NOTES_FILE.

  \`plan\` writes that file. Run it first, or pass RELEASE_NOTES_FILE."

    # `--verify-tag` so this can only ever release a tag that exists, rather than
    # creating one from whatever the runner happens to have checked out.
    # Never `--generate-notes`: the notes are the CHANGELOG section, which is a
    # thing a person wrote and a driver checks.
    # **The installer rides the release, and that is what makes the download
    # source neutral.** The one-liner in `README.md` points at
    # `releases/latest/download/install.sh`, so what a stranger pipes into a
    # shell comes from the repository rather than from anybody's control plane —
    # "where the software is" and "which fleet I join" stay two questions. The
    # copy uploaded here has its placeholder **unsubstituted**, which is the
    # whole point: fetched this way the script has no address in it and asks.
    #
    # Copied under its published name rather than uploaded as `bootstrap.sh#label`:
    # `releases/latest/download/<name>` resolves on the *asset* name, so the file
    # name is part of the URL people paste. `deploy/bootstrap.sh` keeps its own
    # name in the tree, where it sits beside `install.sh` and must not be
    # confused with it.
    [ -f "$RELEASE_ROOT/deploy/bootstrap.sh" ] \
      || fail "refusing $RELEASE_TAG: no deploy/bootstrap.sh to publish as install.sh.

  README.md's one-liner points at that asset; a release without it publishes a
  URL that 404s for everybody who reads it."
    cp "$RELEASE_ROOT/deploy/bootstrap.sh" "$RELEASE_WORK/install.sh"

    # ── every app artifact this release said it would carry ───────────────
    #
    # ⚠ **Refused by name rather than counted, and refused rather than published
    # partially.** `manifest`'s "a silently-skipped matrix leg" argument, one act
    # over and sharper: a release page missing the Windows build is not a partial
    # release, it is a release that looks finished to everybody except the people
    # it was missing for, with every check green and nothing anywhere red.
    #
    # `fail-fast: true` on `release.yml`'s **`app`** matrix already closes the
    # ordinary path — the `app` one specifically, which is worth saying because
    # for one release this sentence stood while the only `fail-fast:` in that
    # file was on the `image` matrix, a different job it says nothing about. The
    # case this exists for is the **re-run-one-job button** that `release.yml`'s
    # header names as its whole recovery story: `actions/download-artifact` with
    # `pattern: app-*` will happily satisfy a re-run with a subset and say
    # nothing. And `app-android` is a job rather than a matrix leg, so no
    # `fail-fast:` covers it at all — this gate is the only thing that does.
    app_check_targets
    set --
    app_missing=""
    for app_name in $(app_asset_names); do
      if [ -f "$RELEASE_APP_DIR/$app_name" ]; then
        set -- "$@" "$RELEASE_APP_DIR/$app_name"
      else
        app_missing="$app_missing $app_name"
      fi
    done
    [ -z "$app_missing" ] || fail "refusing $RELEASE_TAG: RELEASE_APP_TARGETS names artifacts this release does not have:$app_missing

  Every \`app\` job was skipped, failed, or produced something under another name.
  Re-run the failed leg — the tag and the commit do not move — or take the target
  out of RELEASE_APP_TARGETS and say in the notes that it is not published."

    echo "publishing $RELEASE_TAG with $# app artifact(s) and the installer"
    "$GH" release create "$RELEASE_TAG" \
      --title "$RELEASE_TAG" \
      --notes-file "$RELEASE_NOTES_FILE" \
      --verify-tag \
      --latest \
      "$RELEASE_WORK/install.sh" \
      "$@"
    ;;

esac
