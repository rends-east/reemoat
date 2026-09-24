#!/bin/sh
# Reports how far the ACP adapter pins are behind the npm registry; NPM_VIEW and FRESHNESS_ROOT are deploycheck's seams, FRESHNESS_MAX_BEHIND an opt-in margin.
# Exit 0 when current, behind or deprecated; 2 when a pin is unpublished or over the margin; 3 when the registry cannot be asked.
set -eu

NPM_VIEW=${NPM_VIEW:-npm view}

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FRESHNESS_ROOT=${FRESHNESS_ROOT:-$(dirname -- "$_here")}
FRESHNESS_MAX_BEHIND=${FRESHNESS_MAX_BEHIND:-}

fail() {
  echo "$@" >&2
  exit 2
}

# Its own exit code, so a network failure never reads as a verdict about the pin.
unreachable() {
  echo "$@" >&2
  exit 3
}

[ $# -eq 0 ] || fail "usage: deploy/ci-freshness.sh

  Takes no arguments. NPM_VIEW, FRESHNESS_ROOT and FRESHNESS_MAX_BEHIND are the
  variables, and the header of this script says what each decides."

case "$FRESHNESS_MAX_BEHIND" in
  "" | *[!0-9]*)
    [ -z "$FRESHNESS_MAX_BEHIND" ] || fail "refusing: FRESHNESS_MAX_BEHIND=\"$FRESHNESS_MAX_BEHIND\" is not a count of releases." ;;
esac

# Every @agentclientprotocol/*-acp dependency is an adapter, so a new one is checked with no list kept here.

R=$FRESHNESS_ROOT
manifest="$R/package.json"
[ -f "$manifest" ] || fail "refusing: no package.json at $manifest.

  FRESHNESS_ROOT names the tree whose pins are read; it defaults to the checkout
  this script sits in."

pins=$(sed -n 's/^[[:space:]]*"\(@agentclientprotocol\/[^"]*-acp\)":[[:space:]]*"\([^"]*\)".*/\1 \2/p' "$manifest")
[ -n "$pins" ] || fail "refusing: no @agentclientprotocol/*-acp dependency found in $manifest.

  The file is there and the pattern found nothing, which means it was reformatted
  or the adapters moved. Fix the pattern in deploy/ci-freshness.sh rather than
  the file."

# A here-document rather than a pipe, so the loop runs in this shell and its variables survive it.

rows=""
stale=""
over=""

while read -r pkg pinned; do
  [ -n "$pkg" ] || continue

  case "$pinned" in
    *[!0-9.]* | "" | .* | *. | *..*)
      fail "refusing: $pkg is \"$pinned\" in $manifest, which is a range rather than a pin.

  Both adapters are pinned exactly, and \`pnpm pincheck\` is what keeps them so.
  Comparing a range to the registry answers nothing." ;;
  esac

  # npm view fails alike for a missing package and a dead network, so every failure reads as unreachable.
  err=$(mktemp "${TMPDIR:-/tmp}/freshness.XXXXXX")
  # shellcheck disable=SC2086 -- NPM_VIEW is deliberately two words by default
  if ! latest=$($NPM_VIEW "$pkg" dist-tags.latest 2>"$err"); then
    msg=$(cat "$err"); rm -f "$err"
    unreachable "could not ask the registry about $pkg: npm view failed.

$msg

  Nothing is known about the pin either way; this is about the run, not the tree."
  fi
  # shellcheck disable=SC2086
  if ! versions=$($NPM_VIEW "$pkg" versions --json 2>"$err"); then
    msg=$(cat "$err"); rm -f "$err"
    unreachable "could not list the registry's versions of $pkg: npm view failed.

$msg"
  fi
  # shellcheck disable=SC2086
  if ! deprecated=$($NPM_VIEW "$pkg@$pinned" deprecated 2>"$err"); then
    msg=$(cat "$err"); rm -f "$err"
    unreachable "could not ask the registry whether $pkg@$pinned is deprecated: npm view failed.

$msg"
  fi
  rm -f "$err"

  [ -n "$latest" ] || unreachable "the registry answered no \`latest\` tag for $pkg.

  \`npm view $pkg dist-tags.latest\` printed nothing, which is not a version and
  not an error. Nothing is known about the pin either way."

  # Matched as the quoted JSON string with dots escaped, so 0.6.0 cannot match 0.63.0 by prefix.
  quoted=$(printf '"%s"' "$pinned" | sed 's/\./\\./g')
  if ! printf '%s\n' "$versions" | grep -q "$quoted"; then
    stale="$stale $pkg@$pinned"
    rows="$rows
| \`$pkg\` | $pinned | $latest | **not published any more** |"
    echo "$pkg: $pinned is not published any more (latest is $latest)"
    continue
  fi

  # npm lists versions in ascending order, prereleases included, so this counts the releases after the pin.
  behind=$(printf '%s\n' "$versions" | sed -n "/$quoted/,\$p" | grep -c '"' || true)
  behind=$((behind - 1))

  note=""
  [ -z "$deprecated" ] || note=" — deprecated: $deprecated"

  if [ "$pinned" = "$latest" ]; then
    rows="$rows
| \`$pkg\` | $pinned | $latest | current$note |"
    echo "$pkg: $pinned is current$note"
  else
    rows="$rows
| \`$pkg\` | $pinned | $latest | behind by $behind release(s)$note |"
    echo "$pkg: $pinned is behind by $behind release(s); latest is $latest$note"
    if [ -n "$FRESHNESS_MAX_BEHIND" ] && [ "$behind" -gt "$FRESHNESS_MAX_BEHIND" ]; then
      over="$over $pkg@$pinned"
    fi
  fi
done <<EOF
$pins
EOF

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Adapter pins against the npm registry"
    echo
    echo "| adapter | pinned | latest | state |"
    echo "|---|---|---|---|"
    printf '%s\n' "$rows" | sed '/^$/d'
    echo
    echo "Read off \`package.json\`; a person moves a pin and each machine takes it through \`deploy/deploy.sh\`."
  } >> "$GITHUB_STEP_SUMMARY"
fi

[ -z "$stale" ] || fail "refusing: no longer published:$stale

  A version the registry does not serve fails \`pnpm install --frozen-lockfile\`
  on the next machine the one-line installer sets up. Move the pin — a person
  merges the renovate proposal or edits package.json — and \`pnpm pincheck\`
  names every other place it is written."

[ -z "$over" ] || fail "refusing: behind by more than FRESHNESS_MAX_BEHIND=$FRESHNESS_MAX_BEHIND releases:$over

  Report-only is the default; this margin was set on purpose. Move the pin, or
  raise the margin where the job sets it."

exit 0
