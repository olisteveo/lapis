#!/usr/bin/env bash
# Generate a realistic memory clip with Viggle's H3 video model (native audio included).
# Usage: tools/viggle/video.sh <name> <seconds> "<prompt>" [reference.png ...]   (key in .env.local)
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env.local; set +a
name=$1; secs=$2; prompt=$3; shift 3
out=tools/viggle/raw/video; mkdir -p "$out"
refs=(); for r in "$@"; do refs+=(-F "reference_image=@$r"); done
created=$(curl -sS https://apis.viggle.ai/v1/videos -H "Authorization: Bearer $VIGGLE_API_KEY" \
  -F prompt="$prompt" -F quality=high -F resolution=1080p -F aspect_ratio=16:9 -F duration_s="$secs" -F enhance=false ${refs[@]+"${refs[@]}"})
id=$(echo "$created" | jq -r '.id // empty')
[ -n "$id" ] || { echo "$name: create failed: $created" >&2; exit 1; }
for _ in $(seq 1 180); do
  v=$(curl -s "https://apis.viggle.ai/v1/videos/$id" -H "Authorization: Bearer $VIGGLE_API_KEY")
  case $(echo "$v" | jq -r '.status') in
    ready) curl -s -o "$out/$name.mp4" "$(echo "$v" | jq -r '.video_url')"; echo "$name: $(wc -c < "$out/$name.mp4") bytes ($id)"; exit 0 ;;
    failed|cancelled) echo "$name: $(echo "$v" | jq -c '.error')" >&2; exit 1 ;;
  esac
  sleep 5
done
echo "$name: timed out ($id)" >&2; exit 1
