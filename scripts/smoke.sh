#!/usr/bin/env bash
#
# M0 acceptance test: prove the pinned OrcaSlicer binary can slice, headless, with
# no display server, and that the artefacts we build the rest of the product on
# (the .gcode.3mf, the embedded G-code, slice_info.config) are real.
#
# Run inside the image:  docker compose run --rm smoke
#
set -euo pipefail

ORCA_BIN="${ORCA_BIN:-orca-slicer}"
APP_DIR="${APP_DIR:-/app}"
MODEL="${SMOKE_MODEL:-${APP_DIR}/test/fixtures/cube20.stl}"
WORK_ROOT="${WORK_DIR:-/work}"
# The flattener the API itself uses, over the catalog generated at image-build time.
FLATTEN="${APP_DIR}/packages/catalog/dist/flatten-cli.js"

# A common, well-supported printer. 0.4 nozzle, stock 0.20mm process, stock PLA.
PRESET_VENDOR="${SMOKE_VENDOR:-BBL}"
MACHINE_PRESET="${SMOKE_MACHINE:-Bambu Lab X1 Carbon 0.4 nozzle}"
PROCESS_PRESET="${SMOKE_PROCESS:-0.20mm Standard @BBL X1C}"
FILAMENT_PRESET="${SMOKE_FILAMENT:-Bambu PLA Basic @BBL X1C}"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then BOLD=''; RED=''; GREEN=''; DIM=''; OFF=''; fi

SANDBOX=''
LOG=''

fail() {
  echo "" >&2
  echo "${RED}${BOLD}SMOKE TEST FAILED${OFF}${RED}: $*${OFF}" >&2
  if [ -n "$LOG" ] && [ -s "$LOG" ]; then
    echo "${DIM}--- last 60 lines of slicer output ---${OFF}" >&2
    tail -n 60 "$LOG" >&2
    echo "${DIM}--------------------------------------${OFF}" >&2
  fi
  exit 1
}

ok() { echo "  ${GREEN}ok${OFF}  $*"; }

cleanup() {
  # Hard constraint #4: the sandbox is removed on success, failure and signal alike.
  if [ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] && [ "${KEEP_SANDBOX:-0}" != "1" ]; then
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT INT TERM

echo "${BOLD}OrcaSlicer Web — M0 smoke test${OFF}"
echo "${DIM}binary:   ${ORCA_BIN}${OFF}"

command -v "$ORCA_BIN" >/dev/null 2>&1 || fail "'${ORCA_BIN}' is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH (needed by the profile resolver)"
command -v unzip >/dev/null 2>&1 || fail "unzip is not on PATH"
[ -f "$MODEL" ] || fail "test model not found at ${MODEL}"
[ -f "$FLATTEN" ] || fail "the catalog flattener is not in the image at ${FLATTEN}"

# Deliberately assert we are headless: this test exists to prove slicing needs no
# display server, so if one leaks in the assertion is worthless.
if [ -n "${DISPLAY:-}" ]; then
  fail "DISPLAY is set (${DISPLAY}); this test must prove slicing works with no display server"
fi
ok "no DISPLAY set — running headless"

version_line="$("$ORCA_BIN" --help 2>/dev/null | head -n 1 || true)"
[ -n "$version_line" ] || fail "'${ORCA_BIN} --help' produced no output"
ok "slicer responds: ${version_line%%:*}"

mkdir -p "$WORK_ROOT"
SANDBOX="$(mktemp -d "${WORK_ROOT}/smoke.XXXXXXXX")"
LOG="${SANDBOX}/slicer.log"
mkdir -p "${SANDBOX}/profiles" "${SANDBOX}/out"

# ---------------------------------------------------------------------------
# Flatten the preset inheritance chains.
#
# GOTCHA (verified on 2.4.2, docs/SPEC.md "VERIFIED CLI deviations" #1): the CLI
# does not resolve `inherits`. Handing it a stock resources/profiles JSON silently
# applies only that file's own keys and falls back to compiled-in defaults for the
# rest — you get a 200x200 bed and filament_density 0 (hence used_g = 0.00)
# instead of the printer's real values, at exit 0.
#
# This goes through M2's generated catalog, which is baked into the image at build
# time — the SAME code path the API's CatalogProfileResolver uses, so the smoke
# test proves the production resolver rather than a shell-script lookalike. The M0
# stopgap `resolve-profile.mjs` and its interim successor `flatten-preset.mjs` are
# both gone; they existed only while the image shipped no node_modules or dist/.
# ---------------------------------------------------------------------------
resolve() {
  local kind="$1" name="$2" dst="$3"
  node "$FLATTEN" "$PRESET_VENDOR" "$kind" "$name" "$dst" \
    || fail "could not resolve the inherits chain of ${kind} preset '${name}'"
}
resolve machine  "$MACHINE_PRESET"  "${SANDBOX}/profiles/machine.json"
resolve process  "$PROCESS_PRESET"  "${SANDBOX}/profiles/process.json"
resolve filament "$FILAMENT_PRESET" "${SANDBOX}/profiles/filament.json"
ok "resolved presets: ${MACHINE_PRESET} / ${PROCESS_PRESET} / ${FILAMENT_PRESET}"

OUT_3MF="${SANDBOX}/out/smoke.gcode.3mf"

# NOTE on argument order and flags (see docs/SPEC.md "Reference"):
#  * --load-settings takes machine FIRST, then process.
#  * --allow-newer-file is effectively mandatory.
#  * --min-save keeps the archive small.
#  * do NOT combine --outputdir with an absolute --export-3mf path: OrcaSlicer
#    concatenates the two and the export fails with "return -13".
set +e
"$ORCA_BIN" \
  --slice 0 \
  --load-settings "${SANDBOX}/profiles/machine.json;${SANDBOX}/profiles/process.json" \
  --load-filaments "${SANDBOX}/profiles/filament.json" \
  --allow-newer-file \
  --min-save \
  --debug 2 \
  --export-3mf "$OUT_3MF" \
  "$MODEL" > "$LOG" 2>&1
slice_rc=$?
set -e
[ "$slice_rc" -eq 0 ] || fail "slicer exited with code ${slice_rc}"
ok "slice completed (exit 0)"

# --- artefact 1: the .gcode.3mf ------------------------------------------------
[ -f "$OUT_3MF" ] || fail "expected output archive was not created: ${OUT_3MF}"
archive_bytes="$(wc -c < "$OUT_3MF" | tr -d ' ')"
[ "$archive_bytes" -gt 1024 ] || fail "output archive is empty or absurdly small (${archive_bytes} bytes)"
unzip -tqq "$OUT_3MF" >/dev/null 2>&1 || fail "output archive is not a readable ZIP"
ok ".gcode.3mf present and valid (${archive_bytes} bytes)"

EXTRACT="${SANDBOX}/extract"
mkdir -p "$EXTRACT"
unzip -oq "$OUT_3MF" -d "$EXTRACT" || fail "could not extract ${OUT_3MF}"

# --- artefact 2: the embedded G-code -------------------------------------------
GCODE="${EXTRACT}/Metadata/plate_1.gcode"
[ -f "$GCODE" ] || fail "archive contains no Metadata/plate_1.gcode (members: $(cd "$EXTRACT" && find . -type f | tr '\n' ' '))"
gcode_bytes="$(wc -c < "$GCODE" | tr -d ' ')"
gcode_lines="$(wc -l < "$GCODE" | tr -d ' ')"
[ "$gcode_bytes" -gt 0 ] || fail "embedded G-code is empty"
[ "$gcode_lines" -gt 200 ] || fail "embedded G-code has only ${gcode_lines} lines — that is not a sliced 20mm cube"

# "Looks like real G-code": extrusion moves plus the headers the results panel and
# the M5 preview parser will depend on.
#
# NOTE the E-value pattern allows a leading '.' — OrcaSlicer emits `E.02345`, with
# no digit before the decimal point, so a naive `E[0-9]` matches almost nothing.
# Arc fitting also means a share of the extrusions are G2/G3, not G1.
extrusion_re='^G[123] .*E-?[0-9.]'
grep -qE "$extrusion_re" "$GCODE" || fail "embedded G-code contains no extruding moves"
grep -qE '^; total layer number:' "$GCODE" || fail "embedded G-code has no '; total layer number:' header"
grep -qE '^; filament used \[mm\]' "$GCODE" || fail "embedded G-code has no filament-used header"
extrusions="$(grep -cE "$extrusion_re" "$GCODE" || true)"
[ "$extrusions" -gt 500 ] || fail "only ${extrusions} extruding moves — that is not a sliced 20mm cube"
layers="$(sed -n 's/^; total layer number: *//p' "$GCODE" | head -n 1)"
[ -n "$layers" ] && [ "$layers" -gt 10 ] || fail "implausible layer count in G-code: '${layers}'"
ok "G-code: ${gcode_lines} lines, ${extrusions} extruding moves, ${layers} layers"

# --- artefact 3: slice_info.config ---------------------------------------------
INFO="${EXTRACT}/Metadata/slice_info.config"
[ -f "$INFO" ] || fail "archive contains no Metadata/slice_info.config"

attr() { sed -n "s/.*[^_]${1}=\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1; }

used_m="$(attr used_m "$INFO")"
used_g="$(attr used_g "$INFO")"
fil_type="$(attr type "$INFO")"
prediction="$(sed -n 's/.*key="prediction" value="\([^"]*\)".*/\1/p' "$INFO" | head -n 1)"
weight="$(sed -n 's/.*key="weight" value="\([^"]*\)".*/\1/p' "$INFO" | head -n 1)"

positive() { # positive <value> -> 0 if it parses as a number > 0
  case "$1" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  awk -v v="$1" 'BEGIN { exit !(v + 0 > 0) }'
}

positive "$used_m" || fail "slice_info.config has no usable filament length (used_m='${used_m}')"
positive "$used_g" || fail "slice_info.config has no usable filament mass (used_g='${used_g}') — check that the filament preset's inherits chain resolved, filament_density defaults to 0"
positive "$prediction" || fail "slice_info.config has no usable time estimate (prediction='${prediction}')"
ok "slice_info.config: ${used_m} m / ${used_g} g of ${fil_type:-?}, ${prediction}s estimated (weight=${weight:-n/a})"

# The thumbnail is expected to be absent/blank headless — it needs OpenGL. Assert
# nothing about it here; rewriting it client-side is a later milestone.
if [ -f "${EXTRACT}/Metadata/plate_1.png" ]; then
  echo "  ${DIM}note${OFF}  Metadata/plate_1.png present ($(wc -c < "${EXTRACT}/Metadata/plate_1.png" | tr -d ' ') bytes) — expected blank headless"
else
  echo "  ${DIM}note${OFF}  no Metadata/plate_1.png in the archive (expected: thumbnail rendering needs OpenGL)"
fi

echo ""
echo "${GREEN}${BOLD}SMOKE TEST PASSED${OFF}"
echo "  model            $(basename "$MODEL")"
echo "  printer          ${MACHINE_PRESET}"
echo "  process          ${PROCESS_PRESET}"
echo "  filament         ${FILAMENT_PRESET}"
echo "  archive bytes    ${archive_bytes}"
echo "  gcode lines      ${gcode_lines}"
echo "  layers           ${layers}"
echo "  filament used    ${used_m} m / ${used_g} g"
echo "  time estimate    ${prediction} s"
