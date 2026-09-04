#!/bin/sh
# How far behind the registry the two ACP adapter pins are, as a script rather
# than as YAML.
#
# The argument `ci-deploy.sh` opens with, applied to a third act: a workflow file
# is exercised by pushing and watching, so anything in one that *decides*
# something is a decision no driver can reach. `freshness.yml` is therefore a
# checkout and one call, and every outcome below is driven by `deploycheck` with
# no registry and no network, through three seams:
#
#   NPM_VIEW            — how the registry is asked. Invoked as
#                         `$NPM_VIEW <package> <field...>` and word-split on
#                         purpose, because the default is the two words
#                         `npm view`. A stub in the driver answers canned
#                         versions, so current, behind, unpublished, deprecated
#                         and unreachable are each one case.
#   FRESHNESS_ROOT      — the tree whose `package.json` the pins are read off.
#                         Pointed at a synthetic manifest, which is how "the
#                         report follows the pin" is asserted rather than assumed.
#   FRESHNESS_MAX_BEHIND — the one number that turns "behind" from a report into
#                         a refusal. Unset by default, and that default is the
#                         decision this file exists to write down (below).
#
# **Why it exists at all.** `pnpm pincheck` asserts the two adapter pins agree
# with each other and with what is installed, and deliberately does not say
# whether a bump happened — it cannot, offline. Nothing anywhere compared a pin to
# what the registry serves *now*, so a pin could sit for months behind an adapter
# whose model list had changed shape underneath the daemon's own readers
# (`dedupeAliasChoices` is the measured case: 0.63.0 and 0.73.0 describe
# `default` differently, and the browser drew "Default (recommended)" on the one
# it had not been read against). `renovate.json` proposes the bump; this is what
# says, once a week, how stale the pin is whether or not anybody opened that
# proposal.
#
# **What "behind" does: report, and never fail by default.** The outcome table,
# each row a decision:
#
#   current      exit 0, one line per adapter.
#   behind       exit 0, the line says by how many releases and what latest is,
#                and the same row lands in the job summary when there is one.
#                Not a failure, because a scheduled job that goes red every week
#                for a pin somebody has chosen not to move yet is a red that
#                teaches people to ignore red — and the check is worth having
#                only while red is rare. `FRESHNESS_MAX_BEHIND=<n>` is the
#                documented margin: set it, and being behind by more than n
#                releases is a refusal (exit 2) naming the variable.
#   deprecated   exit 0, reported. A deprecated version still installs, with a
#                warning at `pnpm install`; it is the signal that usually precedes
#                the next row, and worth a line before it becomes one.
#   unpublished  exit 2. The pinned version is not in the registry's list any
#                more, which means `pnpm install --frozen-lockfile` fails on the
#                next machine the one-line installer sets up — a real break in
#                the install path, and the one outcome here that is nobody's
#                choice.
#   unreachable  exit 3, a distinct code with a sentence, so a registry outage
#                or a runner with no network reads as that and not as a verdict
#                about the pin. Every other code here is a statement about the
#                tree; this one is a statement about the run.
#
# **What a green run does not earn.** Nothing about whether the newer adapter
# still publishes what this daemon's readers expect — that is what the bump
# itself is measured against, adapter by adapter, before `package.json` moves.
# This only says the question is due.
#
# Nothing here changes anything. It reads one file, asks the registry, prints,
# and appends to `GITHUB_STEP_SUMMARY` when a runner provides one.
set -eu

NPM_VIEW=${NPM_VIEW:-npm view}

_here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FRESHNESS_ROOT=${FRESHNESS_ROOT:-$(dirname -- "$_here")}
FRESHNESS_MAX_BEHIND=${FRESHNESS_MAX_BEHIND:-}

fail() {
  echo "$@" >&2
  exit 2
}

# The registry could not be asked. Its own exit code, because "the pin is bad"
# and "the network is down" are answers to different questions, and a scheduled
# job that reported the second as the first would send somebody to edit a
# manifest that is fine.
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

# ---------------------------------------------------------------------------
# The pins, read off package.json rather than written down here.
#
# Every `@agentclientprotocol/*-acp` dependency is an adapter: that is the shape
# `pincheck`'s `ADAPTERS` list has two entries of, and reading the shape rather
# than copying the list is what keeps a third adapter from being pinned in one
# place and checked in none. Read with `sed`, since a `ci-*` script depends on
# nothing but a shell — `ci-release.sh` says the same about `json_field`.
#
# An empty read is a pattern that stopped matching and has to fail as loudly as
# a stale pin: a check that silently found no adapters to compare would be green
# for ever.
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# One adapter at a time. A here-document rather than a pipe into the loop, so
# the loop runs in this shell and what it collects survives it.
# ---------------------------------------------------------------------------

rows=""
stale=""
over=""

while read -r pkg pinned; do
  [ -n "$pkg" ] || continue

  # A pin is exact or it is not a pin. `pincheck` asserts the same over the
  # installed copy; here a range would make "behind" a question with no answer.
  case "$pinned" in
    *[!0-9.]* | "" | .* | *. | *..*)
      fail "refusing: $pkg is \"$pinned\" in $manifest, which is a range rather than a pin.

  Both adapters are pinned exactly, and \`pnpm pincheck\` is what keeps them so.
  Comparing a range to the registry answers nothing." ;;
  esac

  # The registry, three questions. Each failure is `unreachable` rather than
  # `fail`: `npm view` exits non-zero for a missing *package* as well as for a
  # dead network, and telling those apart from here would mean parsing npm's
  # prose — so both read as "could not ask", with npm's own stderr under it.
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

  # Published: the pinned version is in the registry's own list. Matched as the
  # quoted JSON string with the dots escaped, so 0.63.0 cannot match 0x63x0 and
  # 0.6.0 cannot match 0.63.0 by prefix.
  quoted=$(printf '"%s"' "$pinned" | sed 's/\./\\./g')
  if ! printf '%s\n' "$versions" | grep -q "$quoted"; then
    stale="$stale $pkg@$pinned"
    rows="$rows
| \`$pkg\` | $pinned | $latest | **not published any more** |"
    echo "$pkg: $pinned is not published any more (latest is $latest)"
    continue
  fi

  # How far behind: every version the registry lists after the pinned one. npm
  # lists them in ascending version order, so "after" is "later in the list" —
  # prereleases included, which is why the word is releases and not versions.
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

# ---------------------------------------------------------------------------
# The summary, where there is one to write, and the verdict.
# ---------------------------------------------------------------------------

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
