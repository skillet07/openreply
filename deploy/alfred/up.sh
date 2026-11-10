#!/usr/bin/env bash
# Usage: ./up.sh [docker compose args...]   (default: up -d)
set -euo pipefail
cd "$(dirname "$0")"
set -a; source ./site.env; set +a   # NEXTAUTH_URL, ALLOWED_EMAILS (not in git)
[ $# -eq 0 ] && set -- up -d
exec nbsecret run OPENREPLY_PG_PASSWORD OPENREPLY_STATS_DB_PASSWORD OPENREPLY_NEXTAUTH_SECRET \
  OPENREPLY_CRON_SECRET OPENREPLY_ENCRYPTION_KEY OPENREPLY_FACEBOOK_APP_SECRET \
  OPENREPLY_INSTAGRAM_APP_ID OPENREPLY_INSTAGRAM_APP_SECRET OPENREPLY_WEBHOOK_VERIFY_TOKEN \
  -- docker compose -f compose.yml "$@"
