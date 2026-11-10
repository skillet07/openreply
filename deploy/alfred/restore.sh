#!/usr/bin/env bash
# Usage: ./restore.sh backup/<file>.dump   – replaces the local openreply DB with a Railway dump.
set -euo pipefail
cd "$(dirname "$0")"
DUMP="$1"
C=openreply-postgres-1
docker cp "$DUMP" $C:/tmp/restore.dump
docker exec $C sh -c 'psql -h 127.0.0.1 -p 55433 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS openreply WITH (FORCE)" -c "CREATE DATABASE openreply"'
docker exec $C pg_restore -h 127.0.0.1 -p 55433 -U postgres -d openreply --no-owner --no-acl /tmp/restore.dump
docker exec -e P="$OPENREPLY_STATS_DB_PASSWORD" $C sh -c 'psql -h 127.0.0.1 -p 55433 -U postgres -d openreply -v ON_ERROR_STOP=1 -v p="$P" <<SQL
SELECT format(\$f\$DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=%L) THEN CREATE ROLE nb_stats_ro LOGIN; END IF; END\$\$\$f\$, '\''nb_stats_ro'\'') \gexec
ALTER ROLE nb_stats_ro WITH LOGIN PASSWORD :'\''p'\'';
GRANT CONNECT ON DATABASE openreply TO nb_stats_ro;
GRANT USAGE ON SCHEMA public TO nb_stats_ro;
GRANT SELECT ON "DmLog", "LinkClick", "WebhookEvent" TO nb_stats_ro;
SQL'
docker exec $C rm /tmp/restore.dump
docker exec $C psql -h 127.0.0.1 -p 55433 -U postgres -d openreply -Atc 'select count(*) from "WebhookEvent"' 
