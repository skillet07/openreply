# OpenReply on Alfred

Moved from Railway project `nb-openreply` on 2026-11-10. Code: branch `nb` of github.com/skillet07/openreply.

- Public URL: https://alfred.tailcfc6c9.ts.net (Tailscale Funnel 443 → 127.0.0.1:3310).
- Instagram account `blagov.ai` is connected through Zernio; comments arrive on the Zernio webhook
  `/api/zernio/webhook/<workspaceId>`. Meta app settings were not changed.
- All containers use `network_mode: host`: the default Docker bridge on Alfred has no internet.
  Postgres 127.0.0.1:55433, Redis 127.0.0.1:56380, web 127.0.0.1:3310.
- Secrets come from nbsecret (`OPENREPLY_*`); `site.env` (not in git) has NEXTAUTH_URL and ALLOWED_EMAILS.

Commands (from this folder):

    ./build.sh                 # rebuild image openreply:nb after git pull
    ./up.sh                    # start / apply changes (docker compose up -d)
    ./up.sh ps | logs -f worker | down
    nbsecret run OPENREPLY_STATS_DB_PASSWORD -- ./restore.sh backup/<file>.dump   # replace DB

After changing the public URL: update NEXTAUTH_URL in site.env, `./up.sh`, then copy
`tools/zernio-repoint.ts` into the web container and run `npx tsx zernio-repoint.ts`.

Rollback to Railway: restart web+worker deployments in Railway, run zernio-repoint with the Railway URL,
restore funnel: `tailscale funnel --bg --https=443 http://127.0.0.1:18789` (old config in backup/).
