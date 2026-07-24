#!/usr/bin/env bash
#
# CLI-surface drift check (hard constraint #2).
#
# OrcaSlicer changes its command-line surface between releases without saying so in
# the release notes. This diffs `orca-slicer --help` against a golden file captured
# from the pinned version and fails loudly on any difference — including the version
# string on the first line, so an accidental version change is caught too.
#
# Run inside the image:  docker compose run --rm help-check
# Refresh the golden:    docker compose run --rm help-check --update
#
set -euo pipefail

ORCA_BIN="${ORCA_BIN:-orca-slicer}"
APP_DIR="${APP_DIR:-/app}"
GOLDEN="${GOLDEN_HELP:-${APP_DIR}/test/golden/orca-slicer-help.txt}"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=''; RED=''; GREEN=''; OFF=''; fi

command -v "$ORCA_BIN" >/dev/null 2>&1 || {
  echo "${RED}${BOLD}FAIL${OFF}: '${ORCA_BIN}' is not on PATH" >&2; exit 1;
}

actual="$(mktemp)"
trap 'rm -f "$actual"' EXIT

# stdout only — stderr would carry unrelated environment warnings.
"$ORCA_BIN" --help > "$actual" 2>/dev/null || {
  echo "${RED}${BOLD}FAIL${OFF}: '${ORCA_BIN} --help' exited non-zero" >&2; exit 1;
}

[ -s "$actual" ] || { echo "${RED}${BOLD}FAIL${OFF}: '${ORCA_BIN} --help' produced no output" >&2; exit 1; }

if [ "${1:-}" = "--update" ]; then
  mkdir -p "$(dirname "$GOLDEN")"
  cp "$actual" "$GOLDEN"
  echo "${GREEN}updated${OFF} ${GOLDEN}"
  exit 0
fi

if [ ! -f "$GOLDEN" ]; then
  echo "${RED}${BOLD}FAIL${OFF}: golden file missing at ${GOLDEN}." >&2
  echo "       Capture it with: docker compose run --rm help-check --update" >&2
  exit 1
fi

if diff -u "$GOLDEN" "$actual" > /tmp/help.diff 2>&1; then
  echo "${GREEN}${BOLD}OK${OFF}  orca-slicer --help matches the golden file"
  echo "    $(head -n 1 "$GOLDEN")"
  exit 0
fi

echo "" >&2
echo "${RED}${BOLD}CLI SURFACE DRIFT DETECTED${OFF}" >&2
echo "The pinned OrcaSlicer binary's --help output no longer matches" >&2
echo "  ${GOLDEN}" >&2
echo "" >&2
sed 's/^/    /' /tmp/help.diff >&2
echo "" >&2
echo "If this is an intentional version bump: review every changed line for flags the" >&2
echo "API relies on, then refresh the golden with:" >&2
echo "    docker compose run --rm help-check --update" >&2
exit 1
