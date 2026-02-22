#!/usr/bin/env bash
# Build a complete voice preset from a Kokoro voice ID.
#
# Usage:
#   bash scripts/kokoro/build-voice.sh af_heart
#   bash scripts/kokoro/build-voice.sh am_fenrir --speed 0.6
#   bash scripts/kokoro/build-voice.sh --all          # batch all voices
#
# Pipeline: generate_vowels.py → build-preset.ts → meta.json → test-multi-timbre.ts
#
# Requires: py -3.14 (kokoro_onnx), npx tsx, models/kokoro.onnx, models/voices.npz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# On MSYS/Git Bash, pwd returns /c/Users/... but Node needs C:/Users/...
# Convert all paths to mixed-mode (forward slash, drive letter) for compat
if command -v cygpath &>/dev/null; then
  ROOT="$(cygpath -m "$_ROOT")"
else
  ROOT="$_ROOT"
fi

CALIB_DIR="$ROOT/calib"
PRESETS_DIR="$ROOT/presets"

# Voice ID → human-readable metadata
declare -A VOICE_NAMES=(
  [af_heart]="Heart"
  [af_sky]="Sky"
  [af_aoede]="Aoede"
  [af_jessica]="Jessica"
  [am_fenrir]="Fenrir"
  [am_onyx]="Onyx"
  [am_eric]="Eric"
  [am_liam]="Liam"
  [bf_alice]="Alice"
  [bf_emma]="Emma"
  [bf_isabella]="Isabella"
  [bm_george]="George"
  [bm_lewis]="Lewis"
)

declare -A VOICE_DESCS=(
  [af_heart]="Warm female voice."
  [af_sky]="Light, airy female voice."
  [af_aoede]="Classical female voice."
  [af_jessica]="Clear female voice."
  [am_fenrir]="Powerful male voice."
  [am_onyx]="Deep male voice."
  [am_eric]="Friendly male voice."
  [am_liam]="Natural male voice."
  [bf_alice]="Gentle British female voice."
  [bf_emma]="Warm British female voice."
  [bf_isabella]="Elegant British female voice."
  [bm_george]="Authoritative British male voice."
  [bm_lewis]="Smooth British male voice."
)

# Parse voice gender/accent from ID prefix
voice_tags() {
  local id="$1"
  local prefix="${id:0:2}"
  local gender="" accent=""
  case "$prefix" in
    af) gender="female"; accent="american" ;;
    am) gender="male";   accent="american" ;;
    bf) gender="female"; accent="british"  ;;
    bm) gender="male";   accent="british"  ;;
    *)  gender="unknown"; accent="unknown" ;;
  esac
  echo "[\"kokoro\", \"$gender\", \"$accent\"]"
}

build_one() {
  local voice_id="$1"
  shift
  local speed="0.7"

  # Parse optional --speed
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --speed) speed="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local preset_id="kokoro-${voice_id//_/-}"
  local calib_out="$CALIB_DIR/$voice_id"
  local preset_out="$PRESETS_DIR/$preset_id"
  local name="${VOICE_NAMES[$voice_id]:-$voice_id}"
  local desc="${VOICE_DESCS[$voice_id]:-Kokoro voice $voice_id.}"
  local tags
  tags=$(voice_tags "$voice_id")

  echo "============================================"
  echo "Building voice: $voice_id → $preset_id"
  echo "  Name: $name"
  echo "  Speed: $speed"
  echo "============================================"

  # Step 1: Generate calibration WAVs
  echo ""
  echo "[1/4] Generating calibration WAVs..."
  PYTHONIOENCODING=utf-8 py -3.14 "$ROOT/scripts/kokoro/generate_vowels.py" \
    --voice "$voice_id" --out "$calib_out" --speed "$speed"

  # Step 2: Build preset from WAVs
  echo ""
  echo "[2/4] Building preset assets..."
  npx tsx "$ROOT/src/cli/build-preset.ts" --out "$preset_out" \
    "$calib_out/AH.wav:AH" "$calib_out/EE.wav:EE" "$calib_out/OO.wav:OO"

  # Step 3: Generate meta.json
  echo ""
  echo "[3/4] Writing meta.json..."
  mkdir -p "$preset_out"
  cat > "$preset_out/meta.json" <<METAEOF
{
  "id": "$preset_id",
  "name": "$name",
  "description": "$desc",
  "tags": $tags,
  "defaultTimbre": "AH"
}
METAEOF
  echo "  Wrote: $preset_out/meta.json"

  # Step 4: Quality gate — run multi-timbre test
  echo ""
  echo "[4/4] Running quality gate..."
  if npx tsx "$ROOT/src/cli/test-multi-timbre.ts" "$preset_id" 2>&1; then
    echo ""
    echo "VOICE $voice_id → $preset_id: BUILD SUCCESS"
  else
    echo ""
    echo "VOICE $voice_id → $preset_id: QUALITY GATE FAILED"
    return 1
  fi

  echo ""
}

# --- Main ---

if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/kokoro/build-voice.sh <voice_id> [--speed N]"
  echo "       bash scripts/kokoro/build-voice.sh --all"
  echo ""
  echo "Available voices (in models/voices.npz):"
  PYTHONIOENCODING=utf-8 py -3.14 -c "
import numpy as np; v = np.load('$ROOT/models/voices.npz')
for k in sorted(v.keys()): print(f'  {k}')
"
  exit 0
fi

# --all mode: build every voice in voices.npz
if [[ "$1" == "--all" ]]; then
  shift
  voices=$(PYTHONIOENCODING=utf-8 py -3.14 -c "
import numpy as np
v = np.load('$ROOT/models/voices.npz')
for k in sorted(v.keys()):
    print(k)
")
  passed=0
  failed=0
  failed_list=""
  total=0

  for v in $voices; do
    total=$((total + 1))
    if build_one "$v" "$@"; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
      failed_list="$failed_list $v"
    fi
  done

  echo ""
  echo "============================================"
  echo "BATCH COMPLETE: $passed/$total passed"
  if [[ $failed -gt 0 ]]; then
    echo "FAILED:$failed_list"
    exit 1
  fi
  exit 0
fi

# Single voice mode
build_one "$@"
