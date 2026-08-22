#!/usr/bin/env bash
# Runs ON the EC2 instance itself -- pulls the latest code, rebuilds the
# Docker image, and restarts the container with zero manual steps beyond
# calling this script. Called by .github/workflows/deploy.yml over SSH, and
# safe to run by hand too (e.g. `ssh ec2-user@$IP deploy/deploy.sh`).
set -euo pipefail

REPO_DIR="$HOME/achat"
IMAGE_NAME="achat:latest"
CONTAINER_NAME="achat"

cd "$REPO_DIR"

echo "==> pulling latest main"
git fetch origin main
git reset --hard origin/main

echo "==> building image"
# --pull keeps the base python/node images current; the layer cache still
# makes this fast when only application code changed
docker build --pull -t "$IMAGE_NAME" .

echo "==> restarting container"
# stop+remove the old container by name (idempotent -- a fresh box has none)
# rather than docker compose, since this is a single container with no other
# services to orchestrate; nginx runs as a separate host-level service, not
# in this compose graph
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# --env-file, not baked-in secrets -- .env lives only on the box (see
# SETUP.md step 5), never in the image or the repo
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --gpus all \
  -p 127.0.0.1:7860:7860 \
  --env-file "$REPO_DIR/.env" \
  "$IMAGE_NAME"

echo "==> waiting for health check"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:7860/health >/dev/null 2>&1; then
    echo "==> deploy successful, app is healthy"
    exit 0
  fi
  sleep 2
done

echo "==> app did not become healthy within 60s -- check: docker logs $CONTAINER_NAME" >&2
exit 1
