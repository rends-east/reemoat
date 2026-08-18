#!/bin/sh
# What a runner does to publish a release, as a script rather than as YAML.
#
# The same argument `ci-deploy.sh` opens with, applied to the other act: a
# workflow file is exercised by pushing and watching, so anything in one that
# *decides* something is a decision no driver can reach. `release.yml` is
# therefore a checkout and four calls, and every refusal below is driven by
# `deploycheck` with no registry, no forge and no network, through three seams:
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
#
# **Four verbs, and every one of them re-runs every gate.**
#
#   plan      compute and print; write the release notes out. Touches nothing.
#   image     build one platform and push it **by digest**, claiming no tag.
#   manifest  merge the digests into the tags that people type.
#   publish   create the GitHub Release from the notes `plan` extracted.
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

RELEASE_WORK=${RELEASE_WORK:-${RUNNER_TEMP:-/tmp}/reemoat-release}
RELEASE_NOTES_FILE=${RELEASE_NOTES_FILE:-$RELEASE_WORK/notes.md}
RELEASE_DIGEST_DIR=${RELEASE_DIGEST_DIR:-$RELEASE_WORK/digests}

fail() {
  echo "$@" >&2
  exit 2
}

verb=${1:-}
case "$verb" in
  plan | image | manifest | publish) ;;
  "") fail "usage: deploy/ci-release.sh plan|image|manifest|publish" ;;
  *) fail "unknown verb \"$verb\". One of: plan, image, manifest, publish" ;;
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
# Refuse a commit whose checks are not green.
#
# Byte-for-byte the gate `ci-deploy.sh` applies, with one thing true here that is
# not true there: the `check` *workflow* is green only when the `check` job and
# the `image` job both are. So this gate is strictly stronger than a deploy's —
# the image about to be pushed is the one `imagecheck` already built and started.
#
# `RELEASE_SKIP_CHECK_GATE=1` is the escape, and it is deliberately awkward.
# ---------------------------------------------------------------------------

if [ "${RELEASE_SKIP_CHECK_GATE:-0}" = "1" ]; then
  echo "check gate skipped by RELEASE_SKIP_CHECK_GATE"
else
  verdict=$("$GH" run list --workflow check --commit "$RELEASE_REF" \
    --json conclusion,status --limit 20 \
    --jq '[.[] | select(.status == "completed")] | first | .conclusion // "none"' 2>/dev/null || echo "unknown")
  echo "check for $RELEASE_REF: $verdict"
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
# The verbs.
# ---------------------------------------------------------------------------

case "$verb" in

  plan)
    mkdir -p "$RELEASE_WORK"
    printf '%s\n' "$notes" > "$RELEASE_NOTES_FILE"
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

  publish)
    [ -f "$RELEASE_NOTES_FILE" ] || fail "refusing $RELEASE_TAG: no notes at $RELEASE_NOTES_FILE.

  \`plan\` writes that file. Run it first, or pass RELEASE_NOTES_FILE."

    # `--verify-tag` so this can only ever release a tag that exists, rather than
    # creating one from whatever the runner happens to have checked out.
    # Never `--generate-notes`: the notes are the CHANGELOG section, which is a
    # thing a person wrote and a driver checks.
    echo "publishing $RELEASE_TAG"
    "$GH" release create "$RELEASE_TAG" \
      --title "$RELEASE_TAG" \
      --notes-file "$RELEASE_NOTES_FILE" \
      --verify-tag \
      --latest
    ;;

esac
