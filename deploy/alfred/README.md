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

Railway project `nb-openreply` was deleted on 2026-11-15. The last Railway data is in
`backup/railway-final-20261110-2056.dump` (not in git); restore it with `restore.sh`.

## Connecting one more Zernio account (another Instagram account)

One workspace holds one Zernio key and one profile, and the UI shows only the owner's earliest workspace.
So each extra Instagram account is its own workspace, made by a script. The second workspace is **not visible in
the UI**: change its rules with the same script (`--overwrite-rule`) or in the database.

`tools/add-zernio-workspace.ts` makes the workspace (same owner, OWNER member), saves the key and a fresh webhook secret
encrypted, creates the Zernio webhook `/api/zernio/webhook/<workspaceId>`, adds the Instagram account, and copies one
campaign from an existing workspace with its own report slug and its own link destination. The sample campaign must have
exactly one tracked link. A second run only checks; a copy that differs from the sample is reported, not overwritten
(`--overwrite-rule` to overwrite). `--dry` writes nothing to the database or Zernio. The key is read from the environment
variable named by `--key-env`; nothing secret is printed. Other workspaces are not touched (the script prints md5 of the
sample workspace's rows before and after).

    cd ~/projects/openreply/deploy/alfred
    docker exec openreply-web-1 rm -rf /app/tmp-tools; docker cp tools openreply-web-1:/app/tmp-tools
    nbsecret run ZERNIO_API_KEY_SYSTEMS -- docker exec -e ZERNIO_API_KEY_SYSTEMS openreply-web-1 \
      npx tsx /app/tmp-tools/add-zernio-workspace.ts --key-env ZERNIO_API_KEY_SYSTEMS \
      --profile <zernio profile id> --account <zernio account id> --sample-rule <automation id> \
      --workspace-name <name> --url <destination url> --dry      # drop --dry to apply

The files must sit under `/app` (not `/tmp`): `@/…` and `zod` imports resolve from the app's `node_modules`.
Remove `/app/tmp-tools` afterwards.

Check without a public comment (`tools/zernio-signed-probe.ts`): sends a signed synthetic `comment.received` (text with no
code word) to the public webhook URL and expects 200, then a wrongly signed one and expects 401; `--match "<text>"` runs the
app's keyword matching against the workspace's rules in-process (no queue, no sending).

    docker exec openreply-web-1 npx tsx /app/tmp-tools/zernio-signed-probe.ts --workspace <workspaceId>
    docker exec openreply-web-1 npx tsx /app/tmp-tools/zernio-signed-probe.ts --workspace <workspaceId> --match "<code word>"
