#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
docker compose build
APP_PORT="${APP_PORT:-80}" docker compose up -d app scheduler
docker compose ps
