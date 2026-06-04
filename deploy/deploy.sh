#!/bin/bash
set -euo pipefail

# Pull latest images and restart containers.
# Run this on the LXC after pushing to main and waiting for GitHub Actions to finish.
#
# First-time setup on the LXC:
#   1. Install Docker (see https://docs.docker.com/engine/install/)
#   2. docker login ghcr.io -u dbrooks-workbench --password-stdin  (use a GitHub PAT)
#   3. Copy docker-compose.yml and .env to this directory
#   4. Run this script

COMPOSE_FILE="$(dirname "$0")/../docker-compose.yml"

docker compose -f "$COMPOSE_FILE" pull
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "Deployed. Running containers:"
docker compose -f "$COMPOSE_FILE" ps
