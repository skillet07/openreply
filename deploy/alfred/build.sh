#!/usr/bin/env bash
# Build the image with host networking (Docker bridge on Alfred has no internet).
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build --network host -t openreply:nb .
