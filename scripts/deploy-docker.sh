#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_BASE="${IMAGE_BASE:-postman2api}"
VERSION="${VERSION:-$(date -u +%Y%m%d%H%M%S)}"
IMAGE="${IMAGE_BASE}:${VERSION}"
CONTAINER_NAME="${CONTAINER_NAME:-postman2api}"
HOST_PORT="${PORT:-1930}"
PREFLIGHT="${CONTAINER_NAME}-preflight-${VERSION}"
ROLLBACK="${CONTAINER_NAME}-rollback-${VERSION}"

wait_for_health() {
  local container="$1"
  for _ in $(seq 1 30); do
    local status
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" == "exited" || "$status" == "dead" || "$status" == "unhealthy" ]] && return 1
    sleep 1
  done
  return 1
}

cleanup_preflight() {
  docker rm -f "$PREFLIGHT" >/dev/null 2>&1 || true
}
trap cleanup_preflight EXIT

echo "[deploy] Building immutable image $IMAGE"
docker build --target runtime -t "$IMAGE" .

echo "[deploy] Running isolated health check"
docker run -d --name "$PREFLIGHT" \
  -e PORT=1930 \
  -e DATABASE_PATH=/tmp/postman2api-preflight.db \
  -e API_KEY=preflight \
  -e ENCRYPTION_KEY=preflight-only-not-for-production \
  "$IMAGE" >/dev/null
wait_for_health "$PREFLIGHT" || {
  docker logs "$PREFLIGHT" || true
  echo "[deploy] Preflight failed; the running service was not touched" >&2
  exit 1
}
cleanup_preflight

had_previous=0
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  had_previous=1
  echo "[deploy] Preserving current container as $ROLLBACK"
  docker stop "$CONTAINER_NAME" >/dev/null
  docker rename "$CONTAINER_NAME" "$ROLLBACK"
fi

start_new() {
  docker run -d --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file .env \
    -e PORT=1930 \
    -e DATABASE_PATH=/data/postman2api.db \
    -p "${HOST_PORT}:1930" \
    -v "$ROOT/data:/data" \
    "$IMAGE" >/dev/null
}

if start_new && wait_for_health "$CONTAINER_NAME"; then
  [[ "$had_previous" == "1" ]] && docker rm "$ROLLBACK" >/dev/null
  echo "[deploy] $IMAGE is healthy on port $HOST_PORT"
  exit 0
fi

echo "[deploy] New container failed; rolling back" >&2
docker logs "$CONTAINER_NAME" || true
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
if [[ "$had_previous" == "1" ]]; then
  docker rename "$ROLLBACK" "$CONTAINER_NAME"
  docker start "$CONTAINER_NAME" >/dev/null
fi
exit 1
