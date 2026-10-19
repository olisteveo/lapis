#!/bin/sh
set -e
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
"$BLENDER" -b --factory-startup --python "$ROOT/tools/blender/build_assets.py" -- "$ROOT/public/models" 2>&1 | grep -E "\[lapis\]|Error|Traceback|line [0-9]" || true
ls -la "$ROOT/public/models"
