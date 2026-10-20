#!/usr/bin/env bash
# Generate a Viggle text-to-motion clip and download its Mixamo-skeleton GLB.
# Usage: tools/viggle/text-to-motion.sh <name> <seconds> "<prompt>"   (key in .env.local as VIGGLE_API_KEY)
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env.local; set +a
name=$1; secs=$2; prompt=$3
out=tools/viggle/raw; mkdir -p "$out"
body=$(jq -n --arg t "$prompt" --argjson d "$secs" '{text:$t, duration_seconds:$d}')
created=$(curl -s -X POST https://apis.viggle.ai/v1/motions -H "Authorization: Bearer $VIGGLE_API_KEY" -H "Content-Type: application/json" -d "$body")
id=$(echo "$created" | jq -r '.id // empty')
[ -n "$id" ] || { echo "$name: create failed: $created" >&2; exit 1; }
for _ in $(seq 1 120); do
  m=$(curl -s "https://apis.viggle.ai/v1/motions/$id" -H "Authorization: Bearer $VIGGLE_API_KEY")
  case $(echo "$m" | jq -r '.status') in
    ready)
      url=$(curl -s "https://apis.viggle.ai/v1/motions/$id/export?download_type=glb" -H "Authorization: Bearer $VIGGLE_API_KEY" | jq -r '.mixamo_url')
      curl -s -o "$out/$name.glb" "$url"
      echo "$name: $(wc -c < "$out/$name.glb") bytes (motion $id)"; exit 0 ;;
    failed) echo "$name: failed: $(echo "$m" | jq -c '.error')" >&2; exit 1 ;;
  esac
  sleep 5
done
echo "$name: timed out ($id)" >&2; exit 1
