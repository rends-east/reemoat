#!/bin/sh
# Release verbs plan|image|manifest|app|publish, each re-running every gate; GH, DOCKER, TAURI, NODE, APKSIGNER and RELEASE_ROOT are seams deploycheck stubs.
set -eu

GH=${GH:-gh}
DOCKER=${DOCKER:-docker}

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RELEASE_ROOT=${RELEASE_ROOT:-$(dirname -- "$_here")}

RELEASE_IMAGE=${RELEASE_IMAGE:-ghcr.io/rends-east/reemoat/control-plane}

# linux/amd64 only until imagecheck has built and run this image on arm64.
RELEASE_PLATFORMS=${RELEASE_PLATFORMS:-linux/amd64}
RELEASE_PLATFORM=${RELEASE_PLATFORM:-$RELEASE_PLATFORMS}

RELEASE_LATEST=${RELEASE_LATEST:-1}

# Every target needs a check.yml native leg (deploycheck pairs the two); `-` not `:-`, because an empty list means publish no app.
RELEASE_APP_TARGETS=${RELEASE_APP_TARGETS-macos-arm64 macos-x64 linux-x64 windows-x64 android}
RELEASE_APP_TARGET=${RELEASE_APP_TARGET:-}

RELEASE_ANDROID_KEYSTORE=${RELEASE_ANDROID_KEYSTORE:-}
RELEASE_ANDROID_KEYSTORE_PASSWORD=${RELEASE_ANDROID_KEYSTORE_PASSWORD:-}
RELEASE_ANDROID_KEY_ALIAS=${RELEASE_ANDROID_KEY_ALIAS:-}
RELEASE_ANDROID_KEY_PASSWORD=${RELEASE_ANDROID_KEY_PASSWORD:-}

TAURI=${TAURI:-tauri}
NODE=${NODE:-node}

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

# Re-checked here because RELEASE_SKIP_CHECK_GATE skips pincheck; read with sed since a ci-* script needs nothing but a shell.

manifest_version() {
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1
}

# An empty read means the pattern stopped matching, and must fail as loudly as a disagreement.
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

daemon_version=$(sed -n 's/^export const DAEMON_VERSION = "\([^"]*\)";$/\1/p' "$R/src/version.ts")
agree "src/version.ts" "$daemon_version"

# Stops at the next heading or at the trailing link-reference block, then trims blank lines at both ends.
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

# A pending check is waited on, bounded by the slowest check leg; none is refused at once, since it means a missing actions: read.

if [ "${RELEASE_SKIP_CHECK_GATE:-0}" = "1" ]; then
  echo "check gate skipped by RELEASE_SKIP_CHECK_GATE"
else
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

# GHCR moves an existing tag silently, so a re-release is refused here rather than left to the forge.

if [ "${RELEASE_ALLOW_RETAG:-0}" = "1" ]; then
  echo "existing-release check skipped by RELEASE_ALLOW_RETAG"
else
  if "$GH" release view "$RELEASE_TAG" >/dev/null 2>&1; then
    fail "refusing $RELEASE_TAG: a GitHub Release for it already exists.

  Releases are not edited in place here. Cut the next version, or say so out
  loud: RELEASE_ALLOW_RETAG=1"
  fi
  # Not asked by publish: manifest has just created this tag, and plan already caught a genuine re-release.
  if [ "$verb" != "publish" ] && "$DOCKER" buildx imagetools inspect "$RELEASE_IMAGE:$RELEASE_TAG" >/dev/null 2>&1; then
    fail "refusing $RELEASE_TAG: $RELEASE_IMAGE:$RELEASE_TAG is already published.

  Somebody may have pulled it. Moving a tag under them is the one thing a
  release must not do. Cut the next version, or say so out loud:
  RELEASE_ALLOW_RETAG=1"
  fi
fi

json_field() {
  sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}

source_url=$(sed -n 's/^const SOURCE_URL = "\([^"]*\)";$/\1/p' "$R/packages/control-plane/src/app.ts")
require_read "packages/control-plane/src/app.ts (SOURCE_URL)" "$source_url"

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

tag_version="$RELEASE_IMAGE:$RELEASE_TAG"
tag_sha="$RELEASE_IMAGE:sha-$short_sha"
tag_latest=""
[ "$RELEASE_LATEST" = "1" ] && tag_latest="$RELEASE_IMAGE:latest"

emit() {
  echo "$1=$2"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >> "$GITHUB_OUTPUT"
  return 0
}

app_product=$(json_field "$R/packages/native/src-tauri/tauri.conf.json" productName)
require_read "packages/native/src-tauri/tauri.conf.json (productName)" "$app_product"

app_known="macos-arm64 macos-x64 linux-x64 linux-arm64 windows-x64 android"

app_triple() {
  case "$1" in
    macos-arm64) echo "aarch64-apple-darwin" ;;
    macos-x64) echo "x86_64-apple-darwin" ;;
    linux-x64) echo "x86_64-unknown-linux-gnu" ;;
    linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
    windows-x64) echo "x86_64-pc-windows-msvc" ;;
    android) echo "" ;;
    *) return 1 ;;
  esac
}

# full carries the Node runtime and src/, client neither; decided by whether the platform overlay drops externalBin.
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

# No android arm on purpose: android is its own app-android job rather than a matrix leg.
app_runner() {
  case "$1" in
    macos-arm64 | macos-x64) echo "macos-latest" ;;
    linux-x64) echo "ubuntu-latest" ;;
    linux-arm64) echo "ubuntu-24.04-arm" ;;
    windows-x64) echo "windows-latest" ;;
    *) return 1 ;;
  esac
}

# zipdir uses ditto because zip -r flattens the framework symlinks inside a .app.
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
    # Named exactly, never a glob: AGP writes app-universal-release-unsigned.apk when the build saw no signing key.
    android)
      echo "packages/native/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk|copy|$app_product-$VERSION-android.apk" ;;
    *) return 1 ;;
  esac
}

# Validates every name first: app_artifacts fails inside a pipeline, where set -e (no pipefail) never sees it.
app_check_targets() {
  for _target in $RELEASE_APP_TARGETS; do
    app_triple "$_target" >/dev/null 2>&1 || fail \
      "refusing $RELEASE_TAG: RELEASE_APP_TARGETS names \"$_target\", which is not a target this release knows.

  One of: $app_known

  A name the table does not know contributes no artifact and no asset name, so
  every gate below would pass and the release would be published without it."
  done
}

# Must not call app_check_targets: callers run this inside command substitution, where fail exits only the subshell.
app_asset_names() {
  for _target in $RELEASE_APP_TARGETS; do
    app_artifacts "$_target" | while IFS='|' read -r _glob _how _name; do
      echo "$_name"
    done
  done
}

case "$verb" in

  plan)
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

    # The Android secrets are deliberately not checked here: only the app-android job can read them.

    mkdir -p "$RELEASE_WORK"
    printf '%s\n' "$notes" > "$RELEASE_NOTES_FILE"
    # AGPL section 6 source offer naming this tag, since bundle.licenseFile does not reach a .app.
    printf '\n---\n\nThese builds are AGPL-3.0-only, and conveying a binary is a distribution.\nThe corresponding source for this release is the `Source code` archive on this\npage and %s/tree/%s.\n' \
      "$source_url" "$RELEASE_TAG" >> "$RELEASE_NOTES_FILE"
    # An empty GitHub Actions matrix fails rather than skips, so app_desktop and app_android gate the jobs.
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

    # Labels go into the positional parameters so a description with spaces is not word-split.
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

    # Pushed by digest with no tag (manifest names it); no --load, which deploycheck asserts absent.
    echo "building $RELEASE_PLATFORM for $RELEASE_IMAGE at $RELEASE_TAG"
    "$DOCKER" buildx build \
      --platform "$RELEASE_PLATFORM" \
      --file "$R/deploy/docker/Dockerfile" \
      "$@" \
      --provenance=false \
      --output "type=image,name=$RELEASE_IMAGE,push-by-digest=true,name-canonical=true,push=true" \
      --metadata-file "$meta" \
      "$R"

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
    [ -d "$RELEASE_DIGEST_DIR" ] || fail "refusing $RELEASE_TAG: no digests at $RELEASE_DIGEST_DIR."

    set --
    set -- "$@" --tag "$tag_version" --tag "$tag_sha"
    [ -n "$tag_latest" ] && set -- "$@" --tag "$tag_latest"

    refs=""
    for f in "$RELEASE_DIGEST_DIR"/*; do
      [ -f "$f" ] || continue
      refs="$refs $RELEASE_IMAGE@$(cat "$f")"
    done

    [ -n "$refs" ] || fail "refusing $RELEASE_TAG: $RELEASE_DIGEST_DIR holds no digests.

  Every \`image\` job was skipped or failed to write one. Publishing the tags now
  would create names that resolve to nothing."

    echo "merging$refs"
    # shellcheck disable=SC2086 -- refs is a list of image references, deliberately split
    "$DOCKER" buildx imagetools create "$@" $refs

    # The index digest, not a platform's, is the attestation subject.
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

    # A client leg refuses a runtime staged by an earlier run, because tauri-build copies whatever it finds.
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

    # No --bundles: the kinds come from bundle.targets in the platform overlay.
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
      # Key dir from mktemp, outside RELEASE_WORK, with the trap armed before the write and umask 077 around it.
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

      # A reused Gradle daemon can build without the signing env, so the signature is verified rather than assumed.
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

      # Needs v1 and v2 schemes, checked from API 23 because apksigner ignores v1 at minSdk 24; the printed lines are read, not the exit status.
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

    # --verify-tag releases only an existing tag; install.sh is bootstrap.sh with its placeholder unsubstituted.
    [ -f "$RELEASE_ROOT/deploy/bootstrap.sh" ] \
      || fail "refusing $RELEASE_TAG: no deploy/bootstrap.sh to publish as install.sh.

  README.md's one-liner points at that asset; a release without it publishes a
  URL that 404s for everybody who reads it."
    cp "$RELEASE_ROOT/deploy/bootstrap.sh" "$RELEASE_WORK/install.sh"

    # Missing artifacts are refused by name: a re-run of one job can download a subset, and app-android has no fail-fast.
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
