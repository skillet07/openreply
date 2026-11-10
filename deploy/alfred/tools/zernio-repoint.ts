// Re-point every workspace's Zernio webhook to the current NEXTAUTH_URL.
// Run inside the web container:  npx tsx /tmp/zernio-repoint.ts [--dry]
import { prisma } from '@/lib/db/client';
import { getBaseUrl } from '@/lib/env';
import { decryptToken } from '@/lib/meta/oauth';
import { ensureWebhook, listWebhooks, webhookUrl } from '@/lib/zernio/manage-remote';

const dry = process.argv.includes('--dry');

async function main() {
const conns = await prisma.zernioConnection.findMany();
for (const c of conns) {
  const apiKey = decryptToken(c.apiKey);
  const target = webhookUrl({ baseUrl: getBaseUrl(), workspaceId: c.workspaceId });
  const ours = (await listWebhooks(apiKey)).find(w => w._id === c.webhookId);
  console.log(`workspace ${c.workspaceId.slice(0, 6)}… current: ${ours?.url ?? 'none'} -> target: ${target}`);
  if (dry) continue;
  const id = await ensureWebhook({ apiKey, workspaceId: c.workspaceId, secret: decryptToken(c.webhookSecret), baseUrl: getBaseUrl(), webhookId: c.webhookId });
  if (id !== c.webhookId) await prisma.zernioConnection.update({ where: { workspaceId: c.workspaceId }, data: { webhookId: id } });
  const after = (await listWebhooks(apiKey)).find(w => w._id === id);
  console.log(`  updated, now: ${after?.url}`);
}
await prisma.$disconnect();
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
